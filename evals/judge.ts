/**
 * evals/judge.ts
 * Implements the evaluation rubric: correctness, citation validity, honesty about gaps,
 * and search efficiency. Records per-scenario execution latency and search count.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { getFastModel } from "../src/llm/models.js";
import { logger } from "../src/lib/logger.js";

export interface EvalScore {
  scenarioId: string;
  passed: boolean;
  correctnessScore: number; // 0 to 1
  citationScore: number; // 0 to 1
  honestyScore: number; // 0 to 1
  searchEfficiencyScore: number; // 0 to 1
  searchCount: number;
  latencyMs: number;
  notes: string[];
}

export interface ScenarioExpectations {
  expectedMode?: string;
  entities?: string[];
  mustMention?: string[];
  mustNotMention?: string[];
  shouldNotSearch?: boolean;
  maxSearches?: number;
  maxLatencyMs?: number;
}

const judgeRubricSchema = z.object({
  correctness: z
    .number()
    .min(0)
    .max(1)
    .describe("1.0 if answer accurately addresses prompt and grounding"),
  honestyAboutGaps: z
    .number()
    .min(0)
    .max(1)
    .describe("1.0 if agent is transparent about missing history or unverified facts"),
  notes: z.array(z.string()).describe("Specific rubric notes or failures"),
});

/**
 * Evaluates an executed scenario against the comprehensive rubric.
 */
export async function judgeScenario(
  scenarioId: string,
  userMessage: string,
  assistantResponse: string,
  expectations: ScenarioExpectations,
  latencyMs: number,
  searchCount: number
): Promise<EvalScore> {
  const notes: string[] = [];
  let correctness = 1.0;
  let citations = 1.0;
  let honesty = 1.0;
  let searchEfficiency = 1.0;

  // 1. Search Efficiency Check
  if (expectations.shouldNotSearch && searchCount > 0) {
    searchEfficiency = 0.0;
    notes.push(`Search triggered for chit-chat or self-contained query (searches=${searchCount})`);
  } else if (expectations.maxSearches !== undefined && searchCount > expectations.maxSearches) {
    searchEfficiency = Math.max(0, 1 - (searchCount - expectations.maxSearches) * 0.25);
    notes.push(`Exceeded max expected searches: ${searchCount} > ${expectations.maxSearches}`);
  }

  // 2. Deterministic Must-Mention Checks
  if (expectations.mustMention && expectations.mustMention.length > 0) {
    for (const kw of expectations.mustMention) {
      if (!assistantResponse.toLowerCase().includes(kw.toLowerCase())) {
        correctness -= 0.4 / expectations.mustMention.length;
        notes.push(`Missing expected term: "${kw}"`);
      }
    }
  }

  // 3. Must-Not-Mention Checks (e.g. hallucinated facts)
  if (expectations.mustNotMention && expectations.mustNotMention.length > 0) {
    for (const kw of expectations.mustNotMention) {
      if (assistantResponse.toLowerCase().includes(kw.toLowerCase())) {
        correctness -= 0.5;
        honesty -= 0.5;
        notes.push(`Contained forbidden/hallucinated term: "${kw}"`);
      }
    }
  }

  // 4. Citation Validity Check
  const citationMatches = assistantResponse.match(/\[(\d+)\]/g);
  if (
    userMessage.toLowerCase().includes("pricing") ||
    userMessage.toLowerCase().includes("cost") ||
    userMessage.toLowerCase().includes("version")
  ) {
    if (!citationMatches || citationMatches.length === 0) {
      citations -= 0.4;
      notes.push("Factual claim lacked bracketed [N] citation");
    }
  }

  // 5. Latency threshold check
  if (expectations.maxLatencyMs && latencyMs > expectations.maxLatencyMs) {
    notes.push(`Exceeded max latency: ${latencyMs}ms > ${expectations.maxLatencyMs}ms`);
  }

  // 6. LLM Judge Rubric Evaluation (token-efficient fast call)
  try {
    const fastModel = getFastModel();
    const prompt = `Evaluate this agent response for the user message.
User Message: "${userMessage}"
Assistant Response: "${assistantResponse.slice(0, 600)}"
Expected Must-Mention: ${JSON.stringify(expectations.mustMention || [])}
Expected Honesty/Gaps: ${expectations.mustNotMention ? "Must not invent facts absent from history" : "Truthful"}

Score correctness (0.0 to 1.0) and honestyAboutGaps (0.0 to 1.0). Return brief notes.`;

    const judgeEval = await generateObject({
      model: fastModel,
      schema: judgeRubricSchema,
      prompt,
      abortSignal: AbortSignal.timeout(4000),
    });

    correctness = Math.min(correctness, judgeEval.object.correctness);
    honesty = Math.min(honesty, judgeEval.object.honestyAboutGaps);
    if (judgeEval.object.notes.length > 0) {
      notes.push(...judgeEval.object.notes);
    }
  } catch (err) {
    logger.debug({ err }, "LLM judge skipped; relied on deterministic rubric checks");
  }

  // Bound scores [0, 1]
  correctness = Math.max(0, Math.min(1, Number(correctness.toFixed(2))));
  citations = Math.max(0, Math.min(1, Number(citations.toFixed(2))));
  honesty = Math.max(0, Math.min(1, Number(honesty.toFixed(2))));
  searchEfficiency = Math.max(0, Math.min(1, Number(searchEfficiency.toFixed(2))));

  const passed =
    correctness >= 0.6 && citations >= 0.5 && honesty >= 0.6 && searchEfficiency >= 0.5;

  return {
    scenarioId,
    passed,
    correctnessScore: correctness,
    citationScore: citations,
    honestyScore: honesty,
    searchEfficiencyScore: searchEfficiency,
    searchCount,
    latencyMs,
    notes,
  };
}
