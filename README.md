# Search-Only Chat Agent

A TypeScript/Node chat agent whose **only** external tool is web search. The agent dynamically routes user queries, anchors relative temporal expressions (e.g. _"last Tuesday"_, _"3 Nov"_, _"since Monday"_) against a user timezone, searches with strict budget caps, extracts atomic factual claims, and streams responses over Server-Sent Events (SSE) with grounded citations.

### Why it's different
- **Time resolved in code:** Relative dates are parsed deterministically with chrono-node and Luxon against an injectable clock, not left to LLM guesswork.
- **Claims stored as structured facts and diffed:** Prior answers are stored as atomic `(entity, attribute, value)` tuples in SQLite so revalidation is a verified data diff rather than narrative hallucination.
- **Budget-capped search fan-out:** Strict caps on concurrency, per-turn calls, and volatility-based caching prevent runaway search loops and rate limits. Detailed rationale in [DESIGN.md](DESIGN.md).

**Zero Cost ($0 to run):** Powered entirely by free-tier APIs. Free OpenRouter models have tight per-minute (20 req/min) and per-day (50 req/day without credits) request caps, so heavy testing may hit 429s. Failover to the fallback model is automatic, and reviewers can supply their own key or any paid model ID.

---

## Architecture Overview

```
Client (Vanilla JS / SSE)
       │
       ▼
  POST /api/chat
       │
┌──────┴─────────────────────────────────────────────────────────────────┐
│ Pipeline: runTurn()                                                    │
│                                                                        │
│ 1. context.ts  ──► Temporal anchor (Clock) + resolve dates + memory   │
│ 2. router.ts   ──► Fast LLM: mode (answer|search|revalidate) + queries │
│ 3. executor.ts ──► Parallel search fan-out + LRU cache (volatility TTL)│
│ 4. writer.ts   ──► Strong LLM streams SSE (tokens + citations [1][2]) │
│ 5. ledger.ts   ──► SQLite persistence (turns, messages, FTS5 index)    │
│ 6. claims.ts   ──► Async post-stream claim extraction & diffing        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Quickstart

### 1. Requirements

- Node.js 20+ (ESM)
- npm

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Reviewers should use their own API keys. Edit `.env`:

- **Required:**
  - `OPENROUTER_API_KEY`: [OpenRouter](https://openrouter.ai/keys) (Free tier models available; uncredited accounts get 50 free req/day)
  - At least one search provider:
    - `TAVILY_API_KEY`: [Tavily](https://app.tavily.com/) (Free tier: 1,000 searches/mo)
    - OR `EXA_API_KEY`: [Exa](https://dashboard.exa.ai/) (Free $10 credit)
- **Optional:** The second search key (used in fallback chain `SEARCH_PROVIDERS=tavily,exa`).
- **Model IDs:** Defaults are in `.env.example` and may rotate or retire over time; override with `FAST_MODEL`, `STRONG_MODEL`, or `FALLBACK_MODEL`.

### 4. Try It (Historical Memory & Revalidation)

Time-based questions require prior conversation history in SQLite. Seed the demo conversations:

```bash
npm run seed          # loads demo history (CRM shortlist on Monday, Postgres hosting last Tuesday)
```

Now start the server:

```bash
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)** and try these queries:

- `"Has HubSpot CRM pricing changed since Monday?"` *(Triggers revalidation audit diff against seeded memory)*
- `"What Postgres hosting options were discussed last Tuesday?"` *(Recalls Supabase/Neon discussion from memory)*
- `"What did we discuss about Redis on Friday?"` *(Demonstrates honesty: responds with "I have no record of that")*
- `"What is the latest LTS version of Node.js?"` *(Triggers live web search with citations)*

To reset history back to a clean slate, delete the local database:
```bash
rm data/agent.db       # On Windows PowerShell: Remove-Item data/agent.db
```

---

## Available NPM Scripts

| Script              | Command                   | Purpose                                                               |
| :------------------ | :------------------------ | :-------------------------------------------------------------------- |
| `npm run dev`       | `tsx watch src/server.ts` | Starts development server with hot reload                             |
| `npm start`         | `tsx src/server.ts`       | Starts production server                                              |
| `npm test`          | `vitest run`              | Runs unit tests (date resolver, ledger, claims diff)                  |
| `npm run seed`      | `tsx scripts/seed.ts`     | Populates demo conversation turns into SQLite                         |
| `npm run eval`      | `tsx evals/run.ts`        | Runs evaluation benchmark scenarios with fake clock and search replay |
| `npm run typecheck` | `tsc --noEmit`            | Runs TypeScript compiler type verification                            |
| `npm run lint`      | `eslint .`                | Runs ESLint on all codebase files                                     |
| `npm run format`    | `prettier --write .`      | Formats all files with Prettier                                       |

---

## Running Evaluations

The evaluation suite tests temporal reasoning and search grounding offline using `FakeClock`. Search results are replayed from fixtures; LLM calls are live and need `OPENROUTER_API_KEY`:

```bash
npm run eval
```

Evaluation scenarios are defined in `evals/scenarios/`:
- `crm-pricing-since-monday.json` — Revalidating whether HubSpot prices changed since Monday.
- `what-did-i-ask-3-nov.json` — Recalling questions asked on a specific calendar date using FTS5 and relative date filtering.
- `postgres-hosting-last-tuesday.json` — Recalling options discussed on "last Tuesday".

---

## Troubleshooting

- **401 Unauthorized:** Invalid or missing `OPENROUTER_API_KEY` in `.env`. Verify your key at [openrouter.ai/keys](https://openrouter.ai/keys).
- **429 Rate Limit:** Free-tier model quota reached (50 requests/day or 20 req/min). The system automatically falls back to `FALLBACK_MODEL` and grounded fallback generation; wait for the reset window or provide a paid key / alternate model.
- **"Startup Check Failed / Model ID not found":** A free OpenRouter model ID was retired or renamed. The startup validator lists currently active free models—update `FAST_MODEL`, `STRONG_MODEL`, or `FALLBACK_MODEL` in `.env`.

---

## Design Document

See [DESIGN.md](DESIGN.md) for architectural trade-offs, rejection rationales, and benchmark details.
