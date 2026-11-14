/**
 * src/server.ts
 * Hono application entry point with SSE streaming, message history,
 * seed endpoints, and static asset serving for the vanilla JS frontend.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { getDb, closeDb } from "./memory/db.js";
import { getMessagesBySession } from "./memory/ledger.js";
import { runTurn } from "./pipeline/index.js";
import { seedDatabase } from "../scripts/seed.js";
import { verifyModelsOnStartup } from "./llm/validate.js";

const app = new Hono();

// Initialize SQLite database and migrations at startup
getDb(config.DB_PATH);

// Verify OpenRouter models catalog on startup
await verifyModelsOnStartup();

// Schema for /api/chat request body
const chatRequestSchema = z.object({
  sessionId: z.string().min(1).default("default-session"),
  message: z.string().min(1, "Message cannot be empty"),
  timezone: z.string().optional().default(config.DEFAULT_TIMEZONE),
});

/**
 * POST /api/chat
 * Streams Server-Sent Events (SSE) emitting typed events: status, token, citation, done, error
 */
app.post("/api/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parseResult = chatRequestSchema.safeParse(body);

  if (!parseResult.success) {
    return c.json({ error: "Invalid request body", details: parseResult.error.format() }, 400);
  }

  const { sessionId, message, timezone } = parseResult.data;

  return streamSSE(c, async (stream) => {
    try {
      await runTurn(
        {
          sessionId,
          userMessage: message,
          timezone,
        },
        {
          onEvent: async (event) => {
            await stream.writeSSE({
              data: JSON.stringify(event),
            });
          },
        }
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        data: JSON.stringify({ type: "error", error: errorMessage }),
      });
    } finally {
      await stream.close();
    }
  });
});

/**
 * GET /api/history
 * Returns message history for a given sessionId
 */
app.get("/api/history", (c) => {
  const sessionId = c.req.query("sessionId") || "default-session";
  const messages = getMessagesBySession(sessionId);
  return c.json({ sessionId, messages });
});

/**
 * POST /api/seed
 * Populates historical demo conversations for testing temporal reasoning
 */
app.post("/api/seed", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const count = seedDatabase(undefined, body?.sessionId);
    return c.json({ success: true, seededTurns: count });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ success: false, error: message }, 500);
  }
});

/**
 * Serve static files from public/
 */
app.get("/", (c) => {
  const indexPath = path.resolve("./public/index.html");
  if (fs.existsSync(indexPath)) {
    return c.html(fs.readFileSync(indexPath, "utf-8"));
  }
  return c.text("Public index.html not found", 404);
});

app.use("/*", serveStatic({ root: "./public" }));

// Server startup
const port = config.PORT;
logger.info({ port }, `Starting Hono agent server on http://localhost:${port}`);

const server = serve({
  fetch: app.fetch,
  port,
});

// Graceful shutdown
const shutdown = () => {
  logger.info("Gracefully terminating server...");
  closeDb();
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { app };
