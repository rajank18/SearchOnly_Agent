/**
 * scripts/seed.ts
 * Seeds historical demo conversation turns and claims with realistic past timestamps
 * to test temporal date resolution and memory retrieval.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { getDb } from "../src/memory/db.js";
import { saveMessage, saveTurn, saveClaims } from "../src/memory/ledger.js";
import type { Turn, Claim } from "../src/pipeline/types.js";
import { logger } from "../src/lib/logger.js";

export function seedDatabase(dbPath?: string, targetSessionId?: string): number {
  getDb(dbPath);
  const sid = targetSessionId || "demo-session";

  const demoTurns: Array<{ turn: Turn; claims?: Claim[] }> = [
    {
      turn: {
        id: "seed-turn-1",
        sessionId: sid,
        userMessage: "What is the pricing for HubSpot CRM Starter tier?",
        assistantResponse:
          "As of early November 2026, the HubSpot CRM Starter tier starts at $15/month for 1,000 marketing contacts [1].",
        userTz: "Asia/Kolkata",
        createdAt: "2026-11-09T09:30:00.000Z", // Monday
        searchQueries: ["HubSpot CRM starter pricing"],
        citations: [
          {
            id: 1,
            title: "HubSpot Pricing & Plans",
            url: "https://www.hubspot.com/pricing/crm",
            snippet: "Starter plan starts at $15/month billed monthly.",
          },
        ],
      },
      claims: [
        {
          entity: "HubSpot",
          attribute: "starter_price",
          value: "$15/month",
          sourceUrl: "https://www.hubspot.com/pricing/crm",
          retrievedAt: "2026-11-09T09:30:00.000Z",
          volatility: "high",
        },
      ],
    },
    {
      turn: {
        id: "seed-turn-2",
        sessionId: sid,
        userMessage: "How do I configure Vite with React and TypeScript?",
        assistantResponse:
          "To scaffold a Vite project with React and TypeScript, run: `npm create vite@latest my-app -- --template react-ts`.",
        userTz: "Asia/Kolkata",
        createdAt: "2026-11-03T14:15:00.000Z", // 3 Nov
        searchQueries: ["vite create react typescript template command"],
        citations: [
          {
            id: 1,
            title: "Vite Getting Started",
            url: "https://vitejs.dev/guide/",
            snippet: "npm create vite@latest my-app -- --template react-ts",
          },
        ],
      },
    },
    {
      turn: {
        id: "seed-turn-3",
        sessionId: sid,
        userMessage: "What are the best managed PostgreSQL hosting providers in 2026?",
        assistantResponse:
          "Popular managed PostgreSQL providers include Supabase, Neon (serverless branching), Crunchy Bridge, and AWS RDS [1].",
        userTz: "Asia/Kolkata",
        createdAt: "2026-11-10T11:00:00.000Z", // Last Tuesday
        searchQueries: ["managed postgresql hosting providers 2026"],
        citations: [
          {
            id: 1,
            title: "Top Managed Postgres Platforms",
            url: "https://example.com/postgres-comparison",
            snippet: "Comparison of Neon, Supabase, and AWS RDS.",
          },
        ],
      },
      claims: [
        {
          entity: "PostgreSQL",
          attribute: "top_managed_providers",
          value: "Supabase, Neon, Crunchy Bridge, AWS RDS",
          sourceUrl: "https://example.com/postgres-comparison",
          retrievedAt: "2026-11-10T11:00:00.000Z",
          volatility: "medium",
        },
      ],
    },
  ];

  for (const item of demoTurns) {
    saveMessage(item.turn.sessionId, "user", item.turn.userMessage, item.turn.createdAt);
    saveMessage(item.turn.sessionId, "assistant", item.turn.assistantResponse, item.turn.createdAt);
    saveTurn(item.turn);
    if (item.claims) {
      saveClaims(item.claims, item.turn.id);
    }
  }

  logger.info({ seededCount: demoTurns.length }, "Seeded historical conversation records");
  return demoTurns.length;
}

// If invoked directly from CLI (e.g. npm run seed)
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  try {
    const count = seedDatabase();
    console.log(`\nSuccessfully seeded ${count} historical turns into SQLite database.`);
  } catch (err) {
    console.error("Failed to seed database:", err);
    process.exit(1);
  }
}
