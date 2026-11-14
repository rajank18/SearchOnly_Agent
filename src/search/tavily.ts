/**
 * src/search/tavily.ts
 * SearchProvider implementation for the Tavily Search API.
 * Free tier: 1,000 searches/month.
 */

import type { SearchProvider, SearchOptions } from "./provider.js";
import type { SearchResult } from "../pipeline/types.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export class TavilySearchProvider implements SearchProvider {
  name = "tavily";
  private apiKey: string | undefined;

  constructor(apiKey: string | undefined = config.TAVILY_API_KEY) {
    this.apiKey = apiKey;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error(
        "Tavily API key is missing. Set TAVILY_API_KEY in .env (get a free key at https://app.tavily.com)."
      );
    }

    const limit = opts.limit ?? 5;
    const timeoutMs = opts.timeoutMs ?? config.SEARCH_TIMEOUT_MS;
    const isHighVolatility = opts.volatility === "high";

    logger.debug(
      { provider: this.name, query, limit, isHighVolatility },
      "Executing Tavily search request"
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestPayload: Record<string, unknown> = {
        api_key: this.apiKey,
        query,
        max_results: limit,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
      };

      // Recency bias for high volatility facts (pricing, news, current status)
      if (isHighVolatility) {
        requestPayload.days = opts.days ?? 14;
      }

      if (opts.includeDomains && opts.includeDomains.length > 0) {
        requestPayload.include_domains = opts.includeDomains;
      }
      if (opts.excludeDomains && opts.excludeDomains.length > 0) {
        requestPayload.exclude_domains = opts.excludeDomains;
      }

      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(`Tavily search failed (${response.status}): ${errorText}`);
        (err as unknown as { status: number }).status = response.status;
        throw err;
      }

      const data = (await response.json()) as {
        results?: Array<{
          title: string;
          url: string;
          content: string;
          raw_content?: string;
          score?: number;
          published_date?: string;
        }>;
      };

      const results = data.results || [];
      return results.map((r) => ({
        title: r.title || "Untitled",
        url: r.url,
        snippet: r.content || "",
        content: r.raw_content || r.content || "",
        score: r.score,
        publishedDate: r.published_date,
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}
