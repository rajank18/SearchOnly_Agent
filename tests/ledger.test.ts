/**
 * tests/ledger.test.ts
 * Tests SQLite persistence for messages, turns, FTS5 search, and date-range queries.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb, closeDb } from "../src/memory/db.js";
import {
  saveMessage,
  getMessagesBySession,
  saveTurn,
  getTurnsByDateRange,
  searchHistory,
} from "../src/memory/ledger.js";

describe("memory/ledger", () => {
  const testDbPath = "./data/test-ledger.db";

  beforeEach(() => {
    // Initialize or reset db
    const db = getDb(testDbPath);
    db.exec("DELETE FROM turns; DELETE FROM messages; DELETE FROM claims;");
  });

  afterAll(() => {
    closeDb();
  });

  it("persists messages and retrieves by session", () => {
    const sessionId = "session-1";
    saveMessage(sessionId, "user", "Hello world");
    saveMessage(sessionId, "assistant", "Hello! How can I help you?");

    const msgs = getMessagesBySession(sessionId);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Hello world");
  });

  it("indexes messages in FTS5 and performs full-text queries", () => {
    const sessionId = "session-fts";
    saveMessage(sessionId, "user", "What is the pricing for PostgreSQL on Supabase?");
    saveMessage(sessionId, "assistant", "Supabase PostgreSQL pricing starts with a free tier.");

    const results = searchHistory("PostgreSQL", sessionId);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("PostgreSQL");
  });

  it("persists turns and filters by UTC date range", () => {
    const sessionId = "session-turns";
    const turn1 = {
      id: "turn-101",
      sessionId,
      userMessage: "What is Tavily?",
      assistantResponse: "Tavily is a search engine API built for LLMs.",
      userTz: "Asia/Kolkata",
      createdAt: "2026-11-10T10:00:00.000Z",
    };
    const turn2 = {
      id: "turn-102",
      sessionId,
      userMessage: "What about Exa?",
      assistantResponse: "Exa is an embeddings-based web search API.",
      userTz: "Asia/Kolkata",
      createdAt: "2026-11-12T15:00:00.000Z",
    };

    saveTurn(turn1);
    saveTurn(turn2);

    const turnsInRange = getTurnsByDateRange(
      "2026-11-10T00:00:00.000Z",
      "2026-11-11T00:00:00.000Z",
      sessionId
    );

    expect(turnsInRange.length).toBe(1);
    expect(turnsInRange[0].id).toBe("turn-101");
  });
});
