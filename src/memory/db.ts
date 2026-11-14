/**
 * src/memory/db.ts
 * Manages the SQLite database connection using better-sqlite3 with WAL mode,
 * creates directories if needed, and applies schema migrations on startup.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

let dbInstance: Database.Database | null = null;

/**
 * Initializes and returns the SQLite database instance, executing schema migrations.
 */
export function getDb(dbPath: string = config.DB_PATH): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  // Ensure parent directory exists
  const dir = path.dirname(path.resolve(dbPath));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  logger.info({ dbPath }, "Connecting to SQLite database");
  const db = new Database(dbPath);

  // Enable WAL mode and foreign keys for performance and data integrity
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Read and execute schema migrations
  const schemaPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
    "schema.sql"
  );

  let schemaSql: string;
  if (fs.existsSync(schemaPath)) {
    schemaSql = fs.readFileSync(schemaPath, "utf-8");
  } else {
    // Fallback relative to project root
    schemaSql = fs.readFileSync(path.resolve("./src/memory/schema.sql"), "utf-8");
  }

  db.exec(schemaSql);
  logger.info("Database schema initialized successfully");

  dbInstance = db;
  return dbInstance;
}

/**
 * Closes the active database connection if open.
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info("Database connection closed");
  }
}
