/**
 * src/prompts/claims.ts
 * Prompt definition and structured schema for extracting atomic verifiable factual claims
 * supported directly by cited sources.
 */

import { z } from "zod";

export const atomicClaimSchema = z.object({
  entity: z.string().describe("Specific subject entity, e.g. 'HubSpot' or 'Supabase'"),
  attribute: z
    .string()
    .describe("Specific verifiable attribute, e.g. 'starter_price' or 'database_engine'"),
  value: z
    .string()
    .describe("Normalized factual value or statement, e.g. '$15/month' or 'PostgreSQL'"),
  sourceUrl: z
    .string()
    .describe("Direct source URL from cited references that supports this claim"),
  volatility: z
    .enum(["high", "medium", "low"])
    .describe(
      "'high' for prices/metrics, 'medium' for software features, 'low' for historical facts"
    ),
});

export const claimsListSchema = z.object({
  claims: z.array(atomicClaimSchema),
});

export const CLAIMS_EXTRACTION_SYSTEM_PROMPT = `You are a factual claim extractor for a research assistant.
Analyze the provided assistant response and referenced citations to extract atomic factual claims.

Strict Rules:
1. Extract ONLY factual claims that are explicitly supported by one of the cited sources.
2. sourceUrl MUST match an actual URL present in the citations list. Do not invent URLs.
3. Keep claims atomic: exactly one entity, one attribute, and one value per claim.
4. Assign volatility: 'high' for pricing, plan tiers, or live metrics; 'medium' for software versions/features; 'low' for history/architecture.`;

export function buildClaimsUserPrompt(
  assistantResponse: string,
  citationsList: Array<{ id: number; url: string; title: string }>
): string {
  const citationsText = citationsList.map((c) => `[${c.id}] ${c.title} -> ${c.url}`).join("\n");

  return `### Assistant Response:
${assistantResponse}

### Cited Sources:
${citationsText}

Extract verified atomic claims backed by the cited sources above.`;
}
