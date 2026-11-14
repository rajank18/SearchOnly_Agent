/**
 * src/search/cache.ts
 * In-memory LRU cache with volatility-based TTL (high: 10m, medium: 6h, low: 7d)
 * and SEARCH_REPLAY record/replay capabilities to/from evals/cache/*.json.
 */

import { LRUCache } from "lru-cache";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SearchResult, Volatility } from "../pipeline/types.js";
import { logger } from "../lib/logger.js";

// TTL mapping: high 10m, medium 6h, low 7d
export const TTL_BY_VOLATILITY: Record<Volatility, number> = {
  high: 10 * 60 * 1000, // 10 minutes
  medium: 6 * 60 * 60 * 1000, // 6 hours
  low: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export interface CacheEntry {
  query: string;
  results: SearchResult[];
  cachedAt: number;
  volatility: Volatility;
}

export class SearchCache {
  private cache: LRUCache<string, CacheEntry>;
  private isReplayMode = false;
  private replayFixtures = new Map<string, SearchResult[]>();
  private cacheDir: string;

  constructor(maxEntries: number = 500) {
    this.cache = new LRUCache<string, CacheEntry>({
      max: maxEntries,
      ttlAutopurge: true,
    });
    this.cacheDir = path.resolve("./evals/cache");
  }

  private normalizeKey(query: string, volatility?: Volatility): string {
    const normQ = query.trim().toLowerCase().replace(/\s+/g, " ");
    return volatility ? `${normQ}::${volatility}` : normQ;
  }

  private getDiskCachePath(key: string): string {
    const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
    return path.join(this.cacheDir, `${hash}.json`);
  }

  get(query: string, volatility: Volatility = "medium"): SearchResult[] | undefined {
    const key = this.normalizeKey(query, volatility);
    const bareKey = this.normalizeKey(query);

    // 1. In-memory replay mode (e.g. from eval scenario fixture injection)
    if (this.isReplayMode) {
      const replayed = this.replayFixtures.get(key) || this.replayFixtures.get(bareKey);
      if (replayed) {
        logger.debug({ query }, "Search cache hit (in-memory eval fixture replay)");
        return replayed;
      }
      // Fuzzy/keyword match across fixtures to ensure eval scenarios stay deterministic
      for (const [fixtureKey, fixtureResults] of this.replayFixtures.entries()) {
        const words = fixtureKey.split(" ").filter((w) => w.length > 3);
        if (words.some((w) => bareKey.includes(w))) {
          logger.debug(
            { query, matchedFixture: fixtureKey },
            "Search cache hit (keyword eval fixture match)"
          );
          return fixtureResults;
        }
      }
    }

    // 2. SEARCH_REPLAY=replay environment disk check
    if (process.env.SEARCH_REPLAY === "replay") {
      const filePath = this.getDiskCachePath(key);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(content) as { results: SearchResult[] };
          logger.debug({ query }, "Search cache hit (evals/cache disk replay)");
          return parsed.results;
        } catch (err) {
          logger.warn({ filePath, err }, "Failed reading replay disk cache");
        }
      }
    }

    // 3. LRU In-memory check
    const entry = this.cache.get(key) || this.cache.get(bareKey);
    if (entry) {
      logger.debug({ query, volatility: entry.volatility }, "Search LRU cache hit");
      return entry.results;
    }

    return undefined;
  }

  set(query: string, results: SearchResult[], volatility: Volatility = "medium"): void {
    const key = this.normalizeKey(query, volatility);
    const ttl = TTL_BY_VOLATILITY[volatility];

    this.cache.set(
      key,
      {
        query,
        results,
        cachedAt: Date.now(),
        volatility,
      },
      { ttl }
    );

    // Record mode: write to evals/cache/*.json
    if (process.env.SEARCH_REPLAY === "record") {
      try {
        if (!fs.existsSync(this.cacheDir)) {
          fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        const filePath = this.getDiskCachePath(key);
        fs.writeFileSync(
          filePath,
          JSON.stringify(
            { query, volatility, recordedAt: new Date().toISOString(), results },
            null,
            2
          ),
          "utf-8"
        );
        logger.debug({ query, filePath }, "Recorded search query to evals/cache disk fixture");
      } catch (err) {
        logger.warn({ err }, "Failed saving search record to disk cache");
      }
    }
  }

  enableReplayMode(fixtures: Record<string, SearchResult[]>): void {
    this.isReplayMode = true;
    this.replayFixtures.clear();
    for (const [q, res] of Object.entries(fixtures)) {
      this.replayFixtures.set(this.normalizeKey(q), res);
    }
    logger.info({ fixtureCount: Object.keys(fixtures).length }, "Search cache replay mode enabled");
  }

  disableReplayMode(): void {
    this.isReplayMode = false;
    this.replayFixtures.clear();
  }

  clear(): void {
    this.cache.clear();
    this.replayFixtures.clear();
  }
}

export const searchCache = new SearchCache();
