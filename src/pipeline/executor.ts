/**
 * src/pipeline/executor.ts
 * Executes the routing plan: runs bounded parallel search fan-outs with budget caps,
 * checks and populates the search LRU cache, handles primary domain score boosts,
 * and executes the revalidation branch with atomic claim diffing.
 */

import { generateObject } from "ai";
import type {
  RouterDecision,
  SearchResult,
  TurnContext,
  RevalidationResult,
  RevalidateItem,
  Claim,
} from "./types.js";
import { defaultSearchProvider } from "../search/fallback.js";
import { searchCache } from "../search/cache.js";
import { getClaimsForRevalidation } from "../memory/ledger.js";
import { getFastModel } from "../llm/models.js";
import {
  revalidateResponseSchema,
  REVALIDATE_SYSTEM_PROMPT,
  buildRevalidateUserPrompt,
} from "../prompts/revalidate.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export interface ExecutionArtifacts {
  searchResults: SearchResult[];
  failedQueries: string[];
  revalidationResult?: RevalidationResult;
  sourcesUsed: Array<{ title: string; url: string }>;
}

/**
 * Concurrency runner limiting simultaneous async tasks.
 */
async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, concurrency)) },
    async () => {
      while (currentIndex < items.length) {
        const idx = currentIndex++;
        results[idx] = await fn(items[idx]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/**
 * Applies primary domain and authority boosts (vendor pricing, docs, changelog).
 */
function boostSearchResultScore(res: SearchResult, entities: string[]): number {
  let score = res.score ?? 0.5;
  const urlLower = res.url.toLowerCase();

  // Boost authoritative path endpoints
  if (
    urlLower.includes("/pricing") ||
    urlLower.includes("/changelog") ||
    urlLower.includes("/releases") ||
    urlLower.includes("/docs") ||
    urlLower.includes("/blog")
  ) {
    score += 0.35;
  }

  // Boost matches where domain contains entity name
  for (const ent of entities) {
    if (ent.length > 2 && urlLower.includes(ent.toLowerCase())) {
      score += 0.25;
      break;
    }
  }

  return score;
}

/**
 * Executes a single search query with LRU cache lookup, status reporting, and timeout.
 */
async function executeSingleQuery(
  query: string,
  volatility: RouterDecision["volatility"],
  onStatus?: (msg: string) => void
): Promise<{ query: string; results: SearchResult[]; error?: unknown }> {
  // 1. Check search cache
  const cached = searchCache.get(query, volatility);
  if (cached && cached.length > 0) {
    logger.debug({ query }, "Search query served from cache");
    return { query, results: cached };
  }

  // 2. Report status
  onStatus?.(`Searching web for: "${query.slice(0, 40)}"…`);
  logger.info({ query }, "Executing search query via provider fallback chain");

  try {
    const liveResults = await defaultSearchProvider.search(query, {
      limit: 5,
      timeoutMs: config.SEARCH_TIMEOUT_MS,
      volatility,
    });

    if (liveResults && liveResults.length > 0) {
      searchCache.set(query, liveResults, volatility);
    }
    return { query, results: liveResults || [] };
  } catch (error) {
    logger.warn({ query, error }, "Search query execution failed");
    return { query, results: [], error };
  }
}

/**
 * Executes revalidation by loading past claims, fanning out targeted searches, and auditing changes.
 */
async function executeRevalidation(
  decision: RouterDecision,
  context: TurnContext,
  onStatus?: (msg: string) => void
): Promise<ExecutionArtifacts> {
  const turnIds = context.pastTurns.map((t) => t.id);
  const startIso = context.resolvedDates[0]?.startIso;
  const endIso = context.resolvedDates[0]?.endIso;

  // Retrieve matching historical claims
  const priorClaims = getClaimsForRevalidation({
    entities: decision.entities.length > 0 ? decision.entities : undefined,
    turnIds: turnIds.length > 0 ? turnIds : undefined,
    startIso,
    endIso,
  });

  // If no prior claims exist in ledger, return no_history signal
  if (priorClaims.length === 0) {
    logger.info({ entities: decision.entities }, "No prior claims found for revalidation target");
    return {
      searchResults: [],
      failedQueries: [],
      revalidationResult: {
        hasHistory: false,
        items: [],
      },
      sourcesUsed: [],
    };
  }

  // Group claims by entity
  const claimsByEntity = new Map<string, Claim[]>();
  for (const c of priorClaims) {
    const key = c.entity.toLowerCase();
    const list = claimsByEntity.get(key) || [];
    list.push(c);
    claimsByEntity.set(key, list);
  }

  // Prioritize entities with high volatility claims
  const sortedEntities = Array.from(claimsByEntity.entries()).sort((a, b) => {
    const aHigh = a[1].some((c) => c.volatility === "high") ? 1 : 0;
    const bHigh = b[1].some((c) => c.volatility === "high") ? 1 : 0;
    return bHigh - aHigh;
  });

  const budget = config.MAX_SEARCHES_PER_TURN;
  const entitiesToCheck = sortedEntities.slice(0, budget);
  const uncheckedEntities = sortedEntities.slice(budget).map(([ent]) => ent);

  const currentYear = context.now.getFullYear();
  const searchQueries: string[] = [];

  for (const [_, claims] of entitiesToCheck) {
    const primaryClaim = claims[0];
    const query = `${primaryClaim.entity} ${primaryClaim.attribute} pricing OR changelog OR announcement ${currentYear}`;
    searchQueries.push(query);
  }

  // Run targeted searches in parallel
  onStatus?.(`Revalidating ${entitiesToCheck.length} entity claim(s) against current web data…`);
  const searchExecutionResults = await pMap(
    searchQueries,
    (q) => executeSingleQuery(q, "high", onStatus),
    config.MAX_PARALLEL_SEARCHES
  );

  const allSearchResults: SearchResult[] = [];
  const failedQueries: string[] = [];
  for (const r of searchExecutionResults) {
    if (r.error) failedQueries.push(r.query);
    allSearchResults.push(...r.results);
  }

  // Audit each entity using the fast model
  const diffItems: RevalidateItem[] = [];
  const fastModel = getFastModel();

  for (let i = 0; i < entitiesToCheck.length; i++) {
    const [_, claims] = entitiesToCheck[i];
    const searchRes = searchExecutionResults[i]?.results || [];

    if (searchRes.length === 0) {
      // Mark as unverified if no search evidence obtained
      for (const c of claims) {
        diffItems.push({
          entity: c.entity,
          attribute: c.attribute,
          oldValue: c.value,
          newValue: null,
          status: "unverified",
          evidenceUrl: c.sourceUrl,
        });
      }
      continue;
    }

    const evidenceSnippets = searchRes
      .slice(0, 4)
      .map(
        (s, idx) =>
          `[Source ${idx + 1}] Title: ${s.title}\nURL: ${s.url}\nDate: ${s.publishedDate || "Unknown"}\nContent: ${s.snippet}`
      )
      .join("\n\n");

    const prompt = buildRevalidateUserPrompt(claims, evidenceSnippets, currentYear);

    try {
      const audit = await generateObject({
        model: fastModel,
        schema: revalidateResponseSchema,
        system: REVALIDATE_SYSTEM_PROMPT,
        prompt,
      });

      diffItems.push(...audit.object.items);
    } catch (err) {
      logger.warn(
        { entity: claims[0]?.entity, err },
        "Revalidation LLM comparison failed; falling back to unverified status"
      );
      for (const c of claims) {
        diffItems.push({
          entity: c.entity,
          attribute: c.attribute,
          oldValue: c.value,
          newValue: null,
          status: "unverified",
          evidenceUrl: searchRes[0]?.url || c.sourceUrl,
        });
      }
    }
  }

  // Deduplicate search results by URL
  const seenUrls = new Set<string>();
  const dedupedResults: SearchResult[] = [];
  for (const item of allSearchResults) {
    if (!seenUrls.has(item.url)) {
      seenUrls.add(item.url);
      dedupedResults.push(item);
    }
  }

  return {
    searchResults: dedupedResults,
    failedQueries,
    revalidationResult: {
      hasHistory: true,
      items: diffItems,
      uncheckedEntities: uncheckedEntities.length > 0 ? uncheckedEntities : undefined,
    },
    sourcesUsed: dedupedResults.map((d) => ({ title: d.title, url: d.url })),
  };
}

/**
 * Executes search or revalidation according to the router decision.
 */
export async function executePlan(
  decision: RouterDecision,
  context: TurnContext,
  onStatus?: (msg: string) => void
): Promise<ExecutionArtifacts> {
  if (decision.mode === "answer") {
    return {
      searchResults: [],
      failedQueries: [],
      sourcesUsed: [],
    };
  }

  if (decision.mode === "revalidate") {
    return executeRevalidation(decision, context, onStatus);
  }

  // 'search' mode
  const queriesToRun = decision.queries.slice(0, config.MAX_SEARCHES_PER_TURN);
  if (queriesToRun.length === 0) {
    return {
      searchResults: [],
      failedQueries: [],
      sourcesUsed: [],
    };
  }

  onStatus?.(`Searching web for ${queriesToRun.length} query(ies)...`);
  logger.info({ queries: queriesToRun }, "Executing parallel search queries");

  // Concurrency bounded by MAX_PARALLEL_SEARCHES
  const searchExecutionResults = await pMap(
    queriesToRun,
    (q) => executeSingleQuery(q, decision.volatility, onStatus),
    config.MAX_PARALLEL_SEARCHES
  );

  const rawResults: SearchResult[] = [];
  const failedQueries: string[] = [];

  for (const r of searchExecutionResults) {
    if (r.error) {
      failedQueries.push(r.query);
    }
    rawResults.push(...r.results);
  }

  // Deduplicate by URL and apply domain score boosts
  const seenUrls = new Set<string>();
  const scoredResults: Array<{ res: SearchResult; score: number }> = [];

  for (const item of rawResults) {
    if (!seenUrls.has(item.url)) {
      seenUrls.add(item.url);
      const score = boostSearchResultScore(item, decision.entities);
      scoredResults.push({ res: { ...item, score }, score });
    }
  }

  // Sort descending by boosted score
  scoredResults.sort((a, b) => b.score - a.score);
  const deduped = scoredResults.map((sr) => sr.res);

  return {
    searchResults: deduped,
    failedQueries,
    sourcesUsed: deduped.map((d) => ({ title: d.title, url: d.url })),
  };
}
