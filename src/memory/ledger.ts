/**
 * src/memory/ledger.ts
 * Read and write interfaces for turns, messages, claims, and FTS5 history search.
 * Enforces UTC timestamps and atomic transactions for conversation turns.
 */

import crypto from "node:crypto";
import { getDb } from "./db.js";
import type { Turn, Claim, MessageRecord } from "../pipeline/types.js";

/**
 * Saves a single message to the messages table and triggers FTS5 indexing.
 */
export function saveMessage(
  sessionId: string,
  role: "user" | "assistant" | "system",
  content: string,
  createdAt?: string
): MessageRecord {
  const db = getDb();
  const id = crypto.randomUUID();
  const timestamp = createdAt || new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(id, sessionId, role, content, timestamp);

  return {
    id,
    sessionId,
    role,
    content,
    createdAt: timestamp,
  };
}

/**
 * Fetches recent message history for a given session.
 */
export function getMessagesBySession(sessionId: string, limit: number = 50): MessageRecord[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, session_id as sessionId, role, content, created_at as createdAt
    FROM messages
    WHERE session_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `);

  return stmt.all(sessionId, limit) as MessageRecord[];
}

/**
 * Persists an entire turn and its associated search queries and citations atomically.
 */
export function saveTurn(turn: Turn): void {
  const db = getDb();
  const insertTurn = db.prepare(`
    INSERT OR REPLACE INTO turns (id, session_id, user_message, assistant_response, user_tz, created_at, search_queries, citations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insertTurn.run(
      turn.id,
      turn.sessionId,
      turn.userMessage,
      turn.assistantResponse,
      turn.userTz,
      turn.createdAt,
      turn.searchQueries ? JSON.stringify(turn.searchQueries) : null,
      turn.citations ? JSON.stringify(turn.citations) : null
    );

    if (turn.claims && turn.claims.length > 0) {
      saveClaims(turn.claims, turn.id);
    }
  });

  tx();
}

/**
 * Persists an array of extracted verified claims into the ledger.
 */
export function saveClaims(claims: Claim[], defaultTurnId?: string): void {
  const db = getDb();
  const insertClaim = db.prepare(`
    INSERT OR REPLACE INTO claims (id, turn_id, entity, attribute, value, source_url, retrieved_at, volatility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const c of claims) {
      const claimId = c.id || crypto.randomUUID();
      const turnId = c.turnId || defaultTurnId || null;
      insertClaim.run(
        claimId,
        turnId,
        c.entity,
        c.attribute,
        c.value,
        c.sourceUrl,
        c.retrievedAt,
        c.volatility
      );
    }
  });

  tx();
}

/**
 * Retrieves past turns that occurred within a given UTC ISO-8601 date range.
 */
export function getTurnsByDateRange(startIso: string, endIso: string, sessionId?: string): Turn[] {
  const db = getDb();
  let sql = `
    SELECT id, session_id as sessionId, user_message as userMessage, 
           assistant_response as assistantResponse, user_tz as userTz, 
           created_at as createdAt, search_queries as searchQueriesJson, 
           citations as citationsJson
    FROM turns
    WHERE created_at >= ? AND created_at <= ?
  `;
  const params: unknown[] = [startIso, endIso];

  if (sessionId) {
    sql += ` AND session_id = ?`;
    params.push(sessionId);
  }

  sql += ` ORDER BY created_at ASC`;

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    sessionId: string;
    userMessage: string;
    assistantResponse: string;
    userTz: string;
    createdAt: string;
    searchQueriesJson: string | null;
    citationsJson: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    userMessage: r.userMessage,
    assistantResponse: r.assistantResponse,
    userTz: r.userTz,
    createdAt: r.createdAt,
    searchQueries: r.searchQueriesJson ? JSON.parse(r.searchQueriesJson) : undefined,
    citations: r.citationsJson ? JSON.parse(r.citationsJson) : undefined,
  }));
}

/**
 * Searches past message history using SQLite FTS5 BM25 ranking.
 */
export function searchHistory(
  rawQuery: string,
  sessionId?: string,
  limit: number = 10
): Array<{ messageId: string; sessionId: string; content: string }> {
  const db = getDb();

  // Escape special FTS5 operators to prevent syntax errors
  const sanitizedQuery = rawQuery.replace(/['"*]/g, " ").trim();
  if (!sanitizedQuery) {
    return [];
  }

  // Use prefix matching on the words
  const ftsQuery = sanitizedQuery
    .split(/\s+/)
    .map((w) => `"${w}"*`)
    .join(" ");

  let sql = `
    SELECT f.message_id as messageId, f.session_id as sessionId, f.content
    FROM messages_fts f
    WHERE messages_fts MATCH ?
  `;
  const params: unknown[] = [ftsQuery];

  if (sessionId) {
    sql += ` AND f.session_id = ?`;
    params.push(sessionId);
  }

  sql += ` LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as Array<{
    messageId: string;
    sessionId: string;
    content: string;
  }>;
}

/**
 * Retrieves existing claims by entity name for revalidation.
 */
export function getClaimsByEntity(entity: string): Claim[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT id, turn_id as turnId, entity, attribute, value, 
           source_url as sourceUrl, retrieved_at as retrievedAt, volatility
    FROM claims
    WHERE LOWER(entity) = LOWER(?)
    ORDER BY retrieved_at DESC
  `);

  return stmt.all(entity) as Claim[];
}

/**
 * Retrieves existing claims by specific turn IDs.
 */
export function getClaimsByTurnIds(turnIds: string[]): Claim[] {
  if (turnIds.length === 0) return [];
  const db = getDb();
  const placeholders = turnIds.map(() => "?").join(",");
  const stmt = db.prepare(`
    SELECT id, turn_id as turnId, entity, attribute, value, 
           source_url as sourceUrl, retrieved_at as retrievedAt, volatility
    FROM claims
    WHERE turn_id IN (${placeholders})
    ORDER BY retrieved_at DESC
  `);

  return stmt.all(...turnIds) as Claim[];
}

/**
 * Retrieves existing claims within a date range and/or matching given entities.
 */
export function getClaimsForRevalidation(options: {
  entities?: string[];
  turnIds?: string[];
  startIso?: string;
  endIso?: string;
}): Claim[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.entities && options.entities.length > 0) {
    const entityPlaceholders = options.entities.map(() => "LOWER(entity) = LOWER(?)").join(" OR ");
    conditions.push(`(${entityPlaceholders})`);
    params.push(...options.entities);
  }

  if (options.turnIds && options.turnIds.length > 0) {
    const turnPlaceholders = options.turnIds.map(() => "?").join(",");
    conditions.push(`turn_id IN (${turnPlaceholders})`);
    params.push(...options.turnIds);
  }

  if (options.startIso && options.endIso) {
    conditions.push(`retrieved_at >= ? AND retrieved_at <= ?`);
    params.push(options.startIso, options.endIso);
  }

  if (conditions.length === 0) {
    // If no filter, return most recent claims
    const stmt = db.prepare(`
      SELECT id, turn_id as turnId, entity, attribute, value, 
             source_url as sourceUrl, retrieved_at as retrievedAt, volatility
      FROM claims
      ORDER BY retrieved_at DESC
      LIMIT 20
    `);
    return stmt.all() as Claim[];
  }

  const sql = `
    SELECT id, turn_id as turnId, entity, attribute, value, 
           source_url as sourceUrl, retrieved_at as retrievedAt, volatility
    FROM claims
    WHERE ${conditions.join(" OR ")}
    ORDER BY retrieved_at DESC
  `;

  return db.prepare(sql).all(...params) as Claim[];
}
