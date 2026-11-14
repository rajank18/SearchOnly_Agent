/**
 * src/search/provider.ts
 * Defines the common SearchProvider interface and search options contract
 * that all provider implementations (Tavily, Exa, FallbackChain) must satisfy.
 */

import type { SearchResult, Volatility } from "../pipeline/types.js";

export interface SearchOptions {
  limit?: number;
  timeoutMs?: number;
  volatility?: Volatility;
  days?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchProvider {
  /** Human-readable identifier for logging and attribution */
  name: string;

  /**
   * Executes a web query and returns normalized search results.
   */
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}
