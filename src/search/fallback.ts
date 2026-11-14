/**
 * src/search/fallback.ts
 * Fallback chain that iterates through search providers in configured priority order,
 * gracefully degrading across 429 quota limits or network failures.
 * Includes a circuit breaker that trips after 3 consecutive 429 errors for 60 seconds.
 */

import type { SearchProvider, SearchOptions } from "./provider.js";
import type { SearchResult } from "../pipeline/types.js";
import { TavilySearchProvider } from "./tavily.js";
import { ExaSearchProvider } from "./exa.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

interface ProviderCircuitState {
  consecutive429Count: number;
  circuitOpenUntil: number; // timestamp in ms
}

export class FallbackSearchChain implements SearchProvider {
  name = "fallback-chain";
  private providers: SearchProvider[];
  private circuitStates = new Map<string, ProviderCircuitState>();

  constructor(providers?: SearchProvider[]) {
    if (providers && providers.length > 0) {
      this.providers = providers;
    } else {
      this.providers = this.buildConfiguredProviders();
    }

    for (const p of this.providers) {
      this.circuitStates.set(p.name, { consecutive429Count: 0, circuitOpenUntil: 0 });
    }
  }

  private buildConfiguredProviders(): SearchProvider[] {
    const list: SearchProvider[] = [];
    for (const name of config.SEARCH_PROVIDERS) {
      if (name === "tavily" && config.TAVILY_API_KEY) {
        list.push(new TavilySearchProvider());
      } else if (name === "exa" && config.EXA_API_KEY) {
        list.push(new ExaSearchProvider());
      }
    }
    return list;
  }

  private isCircuitOpen(providerName: string): boolean {
    const state = this.circuitStates.get(providerName);
    if (!state) return false;
    if (state.circuitOpenUntil > Date.now()) {
      return true;
    }
    // Cooldown elapsed, reset to half-open
    if (state.circuitOpenUntil > 0) {
      state.circuitOpenUntil = 0;
      state.consecutive429Count = 0;
    }
    return false;
  }

  private recordSuccess(providerName: string): void {
    const state = this.circuitStates.get(providerName);
    if (state) {
      state.consecutive429Count = 0;
      state.circuitOpenUntil = 0;
    }
  }

  private recordFailure(providerName: string, error: unknown): void {
    const state = this.circuitStates.get(providerName);
    if (!state) return;

    const errMsg = String(error).toLowerCase();
    const status = (error as { status?: number })?.status;
    const is429 =
      status === 429 ||
      errMsg.includes("429") ||
      errMsg.includes("rate limit") ||
      errMsg.includes("quota");

    if (is429) {
      state.consecutive429Count += 1;
      logger.warn(
        { provider: providerName, consecutive429s: state.consecutive429Count },
        "Search provider returned 429 / quota error"
      );

      if (state.consecutive429Count >= 3) {
        state.circuitOpenUntil = Date.now() + 60 * 1000; // Open circuit for 60 seconds
        logger.error(
          { provider: providerName, circuitOpenSeconds: 60 },
          "Circuit breaker TRIPPED for search provider: skipping for 60s"
        );
      }
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    if (this.providers.length === 0) {
      logger.warn("No search providers configured with valid API keys; returning empty results");
      return [];
    }

    const errors: Array<{ provider: string; error: unknown }> = [];

    for (const provider of this.providers) {
      if (this.isCircuitOpen(provider.name)) {
        logger.info(
          { provider: provider.name },
          "Search provider circuit breaker is OPEN; skipping to next in fallback chain"
        );
        continue;
      }

      try {
        logger.debug({ provider: provider.name, query }, "Attempting search provider in chain");
        const results = await provider.search(query, opts);
        this.recordSuccess(provider.name);
        if (results && results.length > 0) {
          return results;
        }
      } catch (error) {
        this.recordFailure(provider.name, error);
        logger.warn(
          { provider: provider.name, error },
          `Search provider ${provider.name} failed, falling over to next provider`
        );
        errors.push({ provider: provider.name, error });
      }
    }

    logger.error(
      { query, errors },
      "All search providers in fallback chain failed or were open-circuited"
    );
    return [];
  }
}

export const defaultSearchProvider = new FallbackSearchChain();
