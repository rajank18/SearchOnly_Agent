/**
 * src/prompts/router.ts
 * Prompt definition for the fast routing model to classify user intent,
 * formulate targeted search queries, identify key entities, and determine fact volatility.
 */

export const ROUTER_SYSTEM_PROMPT = `You are a query classifier and search router for a real-time chat assistant.
Analyze the user message and conversation context to determine the optimal execution path.

Mode classification rules:
- "revalidate": The user explicitly asks whether a previously stated fact/price/claim has changed, is still true/correct, or updated since a past date, turn, or time.
- "search": The answer depends on current external facts that can change (e.g. pricing, releases, docs, news, external specs) or facts you don't reliably know.
- "answer": Chit-chat, conversational pleasantries, math, code explanation, stable historical knowledge, rewriting, OR questions completely answerable from provided conversation history alone (e.g. "what did I ask on 3 Nov?").

Query formulation rules:
- Maximum 5 queries, each <= 8 words.
- When the query is time-sensitive or involves current status/pricing, include the relevant year.
- Keep queries keyword-focused for web search engines.

Entity rules:
- Extract specific named organizations, products, libraries, or technologies (e.g., ["HubSpot", "PostgreSQL", "React"]).

Volatility rules:
- "high": Rapidly shifting data like pricing, stock, breaking news.
- "medium": Library releases, features, documentation.
- "low": General concepts, history, architectural fundamentals.`;

export function buildRouterUserPrompt(
  userMessage: string,
  options: {
    nowFormatted: string;
    resolvedDates?: Array<{ text: string; startIso: string; endIso: string }>;
    pastTurnsSummary?: string;
  }
): string {
  let prompt = `Temporal Anchor: Current time is ${options.nowFormatted}.\n`;

  if (options.resolvedDates && options.resolvedDates.length > 0) {
    prompt += `Resolved Date Ranges in Query:\n`;
    for (const d of options.resolvedDates) {
      prompt += `- "${d.text}" -> from ${d.startIso} to ${d.endIso}\n`;
    }
  }

  if (options.pastTurnsSummary) {
    prompt += `\nRelevant Past Turns in History:\n${options.pastTurnsSummary}\n`;
  }

  prompt += `\nUser Message: "${userMessage}"`;
  return prompt;
}
