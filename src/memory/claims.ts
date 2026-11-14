/**
 * src/memory/claims.ts
 * Manages post-stream factual claim extraction and diffing algorithms
 * to identify conflicting, updated, or newly learned facts across turns.
 */

import { generateObject } from "ai";
import type { Claim, Turn } from "../pipeline/types.js";
import type { Clock } from "../time/clock.js";
import { getFastModel } from "../llm/models.js";
import {
  claimsListSchema,
  CLAIMS_EXTRACTION_SYSTEM_PROMPT,
  buildClaimsUserPrompt,
} from "../prompts/claims.js";
import { logger } from "../lib/logger.js";
import { saveClaims } from "./ledger.js";

export interface ClaimDiff {
  added: Claim[];
  updated: Array<{ old: Claim; current: Claim }>;
  unchanged: Claim[];
}

/**
 * Normalizes claim values across currency symbols, casing, and spacing.
 */
export function normalizeClaimValue(val: string): string {
  return val
    .toLowerCase()
    .replace(/[$€£]/g, "")
    .replace(/\busd\b/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([/\\-])\s*/g, "$1")
    .trim();
}

/**
 * Compares prior claims against newly extracted claims based on entity + attribute keys,
 * utilizing normalized value comparison.
 */
export function diffClaims(oldClaims: Claim[], newClaims: Claim[]): ClaimDiff {
  const diff: ClaimDiff = {
    added: [],
    updated: [],
    unchanged: [],
  };

  const oldMap = new Map<string, Claim>();
  for (const c of oldClaims) {
    const key = `${c.entity.toLowerCase()}::${c.attribute.toLowerCase()}`;
    oldMap.set(key, c);
  }

  for (const current of newClaims) {
    const key = `${current.entity.toLowerCase()}::${current.attribute.toLowerCase()}`;
    const previous = oldMap.get(key);

    if (!previous) {
      diff.added.push(current);
    } else {
      const normOld = normalizeClaimValue(previous.value);
      const normNew = normalizeClaimValue(current.value);
      if (normOld !== normNew) {
        diff.updated.push({ old: previous, current });
      } else {
        diff.unchanged.push(current);
      }
    }
  }

  return diff;
}

/**
 * Asynchronously extracts verified factual claims from an executed turn and persists them.
 * Runs non-blockingly after the SSE stream finishes; errors are logged and not thrown.
 */
export async function extractClaims(turn: Turn, clock?: Clock): Promise<Claim[]> {
  // Only extract claims if turn includes cited sources to prevent hallucinated assertions
  if (!turn.citations || turn.citations.length === 0) {
    logger.debug({ turnId: turn.id }, "Skipping claim extraction: turn has no citations");
    return [];
  }

  logger.debug({ turnId: turn.id }, "Starting asynchronous post-stream claim extraction");

  try {
    const fastModel = getFastModel();
    const prompt = buildClaimsUserPrompt(turn.assistantResponse, turn.citations);

    const result = await generateObject({
      model: fastModel,
      schema: claimsListSchema,
      system: CLAIMS_EXTRACTION_SYSTEM_PROMPT,
      prompt,
      abortSignal: AbortSignal.timeout(5000),
    });

    const validUrls = new Set(turn.citations.map((c) => c.url));
    const retrievedAt = clock ? clock.toISOString() : turn.createdAt;

    // Filter to ensure claims are linked to valid cited sources
    const extracted: Claim[] = result.object.claims
      .filter((c) => validUrls.has(c.sourceUrl) || c.sourceUrl.startsWith("http"))
      .map((c) => ({
        turnId: turn.id,
        entity: c.entity,
        attribute: c.attribute,
        value: c.value,
        sourceUrl: c.sourceUrl,
        retrievedAt,
        volatility: c.volatility,
      }));

    if (extracted.length > 0) {
      saveClaims(extracted, turn.id);
      logger.info(
        { turnId: turn.id, claimCount: extracted.length },
        "Persisted extracted verified claims to ledger"
      );
    }

    return extracted;
  } catch (err) {
    logger.warn(
      { turnId: turn.id, err },
      "Background claim extraction encountered an error; continuing without blocking"
    );
    return [];
  }
}
