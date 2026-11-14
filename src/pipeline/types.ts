/**
 * src/pipeline/types.ts
 * Core shared TypeScript interfaces and domain models across the pipeline,
 * search subsystem, memory ledger, and SSE stream.
 */

import type { ResolvedDateRange } from "../time/resolver.js";

export type Volatility = "high" | "medium" | "low";

export type ExecutionMode = "answer" | "search" | "revalidate";

/**
 * Complete context passed through pipeline stages.
 */
export interface TurnContext {
  sessionId: string;
  userMessage: string;
  timezone: string;
  now: Date;
  nowIso: string;
  nowFormatted: string;
  resolvedDates: ResolvedDateRange[];
  pastTurns: Turn[];
  recentMessages: MessageRecord[];
}

/**
 * Atomic verified fact extracted from search results or previous conversation turns.
 */
export interface Claim {
  id?: string;
  turnId?: string;
  entity: string;
  attribute: string;
  value: string;
  sourceUrl: string;
  retrievedAt: string; // ISO-8601 UTC timestamp
  volatility: Volatility;
}

/**
 * Citation reference linking generated statements to external sources.
 */
export interface Citation {
  id: number;
  url: string;
  title: string;
  snippet?: string;
}

/**
 * Output of the small fast routing model that directs how the turn will be executed.
 */
export interface RouterDecision {
  mode: ExecutionMode;
  queries: string[];
  entities: string[];
  volatility: Volatility;
  rationale?: string;
  referencedRange?: { start: string; end: string };
}

/**
 * Result returned from a search provider.
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  score?: number;
  publishedDate?: string;
}

export type RevalidateStatus = "changed" | "unchanged" | "unverified";

export interface RevalidateItem {
  entity: string;
  attribute: string;
  oldValue: string;
  newValue: string | null;
  status: RevalidateStatus;
  evidenceUrl: string;
  evidenceDate?: string;
}

export interface RevalidationResult {
  hasHistory: boolean;
  items: RevalidateItem[];
  uncheckedEntities?: string[];
}

/**
 * Complete record of a single conversation exchange.
 */
export interface Turn {
  id: string;
  sessionId: string;
  userMessage: string;
  assistantResponse: string;
  userTz: string;
  createdAt: string; // ISO-8601 UTC timestamp
  searchQueries?: string[];
  citations?: Citation[];
  claims?: Claim[];
}

/**
 * Message entry for raw chat transcripts stored in SQLite.
 */
export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string; // ISO-8601 UTC timestamp
}

/**
 * Typed events emitted over the Server-Sent Events (SSE) stream.
 */
export type StreamEvent =
  | { type: "status"; message: string; stage?: string }
  | { type: "token"; content: string }
  | { type: "citation"; citation: Citation }
  | { type: "done"; turnId: string; metadata?: Record<string, unknown> }
  | { type: "error"; error: string };
