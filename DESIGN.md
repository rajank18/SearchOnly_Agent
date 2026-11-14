# Architecture & Design

## How it works

I designed this agent to answer queries using web search and SQLite memory without paid infrastructure. OpenRouter serves as the primary and sole LLM provider, using free-tier models with intra-provider fallback for rate-limit resilience. When a message arrives, the pipeline anchors time via an injectable clock, resolves relative date expressions into UTC intervals in code with chrono-node, and retrieves matching turns from SQLite. A fast model classifies intent into answer, search, or revalidate modes with a 3-second timeout before falling back to a rule-based router. The executor runs parallel searches under budget caps, consulting a volatility-aware LRU cache and an ordered provider chain (Tavily, Exa) with a 60-second circuit breaker. The strong model streams answers over SSE with verified citation brackets, and an asynchronous worker persists atomic claims to SQLite.

```
context (time + history)
  → router (mode + queries + volatility)
  → executor (answer | search | revalidate)
  → writer (streamed tokens + citation validation)
  → async claim ledger (atomic SQLite tuples)
```

## Why this design

- **OpenRouter as unified gateway**: Standardizing on OpenRouter via `@ai-sdk/openai-compatible` eliminates multi-SDK vendor sprawl. When free-tier rate limits or transient errors occur, the system fails over to an alternate model on the same gateway.
- **Deterministic time resolution in code**: I parse expressions like "last Tuesday" or "3 Nov" with chrono-node and Luxon against an injectable clock rather than relying on LLM date math, which frequently hallucinates calendar intervals.
- **Structured claims ledger for revalidation**: I store facts as atomic `(entity, attribute, value, sourceUrl, volatility)` tuples in SQLite so that checking whether a fact changed is an explicit value diff rather than an ungrounded narrative comparison.
- **SQLite and FTS5 over vector storage**: I chose SQLite with BM25 full-text search and date filtering because memory recall keys off exact timestamps, entities, and keywords, eliminating external vector database dependencies.
- **Tiered model routing**: I use a fast model for intent classification with a 3-second timeout and reserve the strong model for final synthesis, keeping conversational latency bounded.
- **Code-enforced honesty constraints**: The pipeline emits an explicit `no_history` signal when past records are absent, requires newer evidence to mark claims "unchanged", and strips invalid citation brackets post-generation.

## Considered and rejected

- **Multi-provider SDK sprawl (Google AI Studio + OpenAI)**: Rejected maintaining parallel proprietary SDK adapters in favor of a single OpenAI-compatible interface with intra-gateway model fallback.
- **LangGraph / multi-agent frameworks**: Rejected because coordinating multiple communicating agent runtimes adds dependency bloat and non-deterministic latency to a single-purpose pipeline.
- **Unbounded ReAct loops**: Rejected because autonomous thought-action search loops risk exhausting free-tier quotas without strict budget guarantees.
- **Vector database memory (e.g. Pinecone, Chroma)**: Rejected because semantic embeddings blur exact temporal boundaries ("yesterday" vs "last week") and require external service daemons.
- **LLM-driven date arithmetic**: Rejected because prompt-based calendar translation fails silently on leap years, relative weekdays, and timezone offsets.
- **Summarized conversational memory blobs**: Rejected because repeated lossy summarization causes progressive factual drift of verified historical claims.

## Results and limits

The benchmark suite was evaluated under an injected `FakeClock` with search replayed from fixtures, not live search. LLM calls were live to OpenRouter, but during this run the uncredited free-tier account hit its 50 requests/day cap, so the pipeline exercised its resilient fallback paths (heuristic router and grounded fallback generation). Crucially, the eval is graded by a free model that is weaker than the answerer, so "8/8 PASS" shows pipeline plumbing and fallback wiring work rather than certifying high qualitative answer prose:

| Scenario                        | Status | Searches | Latency  |
| :------------------------------ | :----- | :------- | :------- |
| `crm-pricing-since-monday`      | PASS   | 1        | 22,717ms |
| `no-history-honesty`            | PASS   | 0        | 10,125ms |
| `postgres-hosting-last-tuesday` | PASS   | 0        | 9,654ms  |
| `pure-chit-chat`                | PASS   | 0        | 9,541ms  |
| `relative-date-yesterday`       | PASS   | 0        | 9,504ms  |
| `revalidate-unchanged`          | PASS   | 2        | 17,400ms |
| `single-fresh-fact-search`      | PASS   | 1        | 10,161ms |
| `what-did-i-ask-3-nov`          | PASS   | 0        | 9,937ms  |

_Total: 8/8 passed._ Latencies (9-22s) stem directly from free-tier inference queuing, rate-limit backoff, and cold starts.

Known limits in the current codebase:

- Citations are validated after full response generation; citation metadata is dispatched at completion rather than mid-stream.
- Exa page content extraction is capped at 1,200 characters per result to stay within free payload tiers.
- OpenRouter uncredited accounts enforce strict 20 req/min and 50 req/day limits, which trigger fallback paths once exceeded.
- Router inference occasionally hits the 3-second timeout on busy free models, falling back to the heuristic router.

## With another week

- **Proactive freshness scheduler**: Background cron worker that re-verifies high-volatility claims before the user asks.
- **Source-quality scoring**: Domain authority weighting favoring official vendor documentation, changelogs, and release feeds over aggregators.
- **Streaming citation validation**: Token-level parser validating bracketed references on the fly to emit citation pills mid-stream.
- **Router tuning from trace logs**: Fine-tuning the routing prompt on real query logs to eliminate 3-second classification timeouts.
