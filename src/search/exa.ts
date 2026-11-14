/**
 * src/search/exa.ts
 * SearchProvider implementation for the Exa Neural Search API.
 * Free tier: $10 credit on signup.
 */

import type { SearchProvider, SearchOptions } from "./provider.js";
import type { SearchResult } from "../pipeline/types.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export class ExaSearchProvider implements SearchProvider {
  name = "exa";
  private apiKey: string | undefined;

  constructor(apiKey: string | undefined = config.EXA_API_KEY) {
    this.apiKey = apiKey;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error(
        "Exa API key is missing. Set EXA_API_KEY in .env (get a free key at https://dashboard.exa.ai)."
      );
    }

    const limit = opts.limit ?? 5;
    const timeoutMs = opts.timeoutMs ?? config.SEARCH_TIMEOUT_MS;
    const isHighVolatility = opts.volatility === "high";

    logger.debug(
      { provider: this.name, query, limit, isHighVolatility },
      "Executing Exa search request"
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestPayload: Record<string, unknown> = {
        query,
        numResults: limit,
        useAutoprompt: true,
        contents: {
          text: { maxCharacters: 1200 },
        },
      };

      // Recency bias for high volatility facts
      if (isHighVolatility) {
        const daysAgo = opts.days ?? 14;
        const startDate = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
        requestPayload.startPublishedDate = startDate;
      }

      if (opts.includeDomains && opts.includeDomains.length > 0) {
        requestPayload.includeDomains = opts.includeDomains;
      }
      if (opts.excludeDomains && opts.excludeDomains.length > 0) {
        requestPayload.excludeDomains = opts.excludeDomains;
      }

      const response = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(`Exa search failed (${response.status}): ${errorText}`);
        (err as unknown as { status: number }).status = response.status;
        throw err;
      }

      const data = (await response.json()) as {
        results?: Array<{
          title: string;
          url: string;
          text?: string;
          score?: number;
          publishedDate?: string;
        }>;
      };

      const results = data.results || [];
      return results.map((r) => ({
        title: r.title || "Untitled",
        url: r.url,
        snippet: r.text?.slice(0, 400) || "",
        content: r.text || "",
        score: r.score,
        publishedDate: r.publishedDate,
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}
