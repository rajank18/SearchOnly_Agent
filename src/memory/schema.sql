-- src/memory/schema.sql
-- Database schema for agent memory: messages, turns, search logs, claims ledger, and FTS5 full-text search.

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created 
ON messages(session_id, created_at ASC);

-- Turns table storing conversation rounds and structured artifacts
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_message TEXT NOT NULL,
  assistant_response TEXT NOT NULL,
  user_tz TEXT NOT NULL,
  created_at TEXT NOT NULL, -- ISO-8601 UTC
  search_queries TEXT,      -- JSON array of queries executed
  citations TEXT            -- JSON array of citations returned
);

CREATE INDEX IF NOT EXISTS idx_turns_session_created 
ON turns(session_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_turns_created 
ON turns(created_at ASC);

-- Search execution history for auditability, replay, and cache validation
CREATE TABLE IF NOT EXISTS searches (
  id TEXT PRIMARY KEY,
  turn_id TEXT,
  query TEXT NOT NULL,
  provider TEXT NOT NULL,
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL, -- ISO-8601 UTC
  FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_searches_turn 
ON searches(turn_id);

-- Claims ledger storing extracted facts for fast revalidation and temporal tracking
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  turn_id TEXT,
  entity TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT NOT NULL,
  retrieved_at TEXT NOT NULL, -- ISO-8601 UTC
  volatility TEXT NOT NULL CHECK(volatility IN ('high', 'medium', 'low')),
  FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_claims_entity 
ON claims(entity);

CREATE INDEX IF NOT EXISTS idx_claims_turn 
ON claims(turn_id);

-- Full-Text Search (FTS5) table indexing message content
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  message_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Triggers to synchronize messages into messages_fts automatically
CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts (content, session_id, message_id)
  VALUES (new.content, new.session_id, new.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_messages_au AFTER UPDATE ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts (content, session_id, message_id)
  VALUES (new.content, new.session_id, new.id);
END;
