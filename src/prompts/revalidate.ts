/**
 * src/prompts/revalidate.ts
 * Prompt definition and structured schema for revalidating previously recorded claims
 * against fresh web search evidence.
 */

import { z } from "zod";
import type { Claim } from "../pipeline/types.js";

export const revalidateItemSchema = z.object({
  entity: z.string(),
  attribute: z.string(),
  oldValue: z.string(),
  newValue: z.string().nullable().describe("New confirmed value, or null if unchanged/unverified"),
  status: z.enum(["changed", "unchanged", "unverified"]),
  evidenceUrl: z.string().describe("Direct URL from search results providing evidence"),
  evidenceDate: z
    .string()
    .optional()
    .describe("Publication or retrieval date of the evidence source"),
});

export const revalidateResponseSchema = z.object({
  items: z.array(revalidateItemSchema),
  overallSummary: z
    .string()
    .describe("Two-line executive summary of factual changes or confirmations"),
});

export const REVALIDATE_SYSTEM_PROMPT = `You are a meticulous factual revalidation auditor.
Your job is to strictly compare prior recorded claims against newly retrieved web search results.

Verification Rules:
1. "changed": Use ONLY if fresh search evidence demonstrates a new, different value (e.g., price increase/decrease, new release). Set newValue to the updated value and cite the exact evidenceUrl.
2. "unchanged": Use ONLY if fresh evidence from a source dated AFTER the original claim (or explicitly stating current status for the reference year) confirms the oldValue is still in effect.
3. "unverified": Use if the search results do not mention this specific attribute, are ambiguous, or only repeat older information. Set newValue to null.
4. Never invent or hallucinate facts or URLs. If evidence is lacking, classify as "unverified".`;

export function buildRevalidateUserPrompt(
  priorClaims: Claim[],
  freshSearchResults: string,
  currentYear: number
): string {
  const claimsText = priorClaims
    .map(
      (c) =>
        `- Entity: "${c.entity}" | Attribute: "${c.attribute}" | Stated Value: "${c.value}" (Originally recorded: ${c.retrievedAt})`
    )
    .join("\n");

  return `Current Reference Year: ${currentYear}

### Prior Recorded Claims to Audit:
${claimsText}

### Fresh Web Search Evidence:
${freshSearchResults}

Compare each claim against the evidence and return the structured audit result.`;
}
