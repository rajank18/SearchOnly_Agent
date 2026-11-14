/**
 * src/llm/models.ts
 * OpenRouter-native model factory providing fast, strong, and fallback LLM instances.
 * Operates at $0 cost on free models with intra-provider model failover.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

function getOpenRouterProvider() {
  return createOpenAICompatible({
    name: "openrouter",
    baseURL: config.OPENROUTER_BASE_URL,
    apiKey: config.OPENROUTER_API_KEY,
  });
}

/**
 * Returns the small/fast model used for routing, claim extraction, and temporal classification.
 */
export function getFastModel(): LanguageModel {
  const provider = getOpenRouterProvider();
  const modelName = config.FAST_MODEL;
  logger.debug({ model: modelName }, "Selected fast model");
  return provider(modelName);
}

/**
 * Returns the strong model used for final synthesis and citation-grounded response generation.
 */
export function getStrongModel(): LanguageModel {
  const provider = getOpenRouterProvider();
  const modelName = config.STRONG_MODEL;
  logger.debug({ model: modelName }, "Selected strong model");
  return provider(modelName);
}

/**
 * Returns the fallback model within OpenRouter when primary model encounters repeated 429 rate limits.
 */
export function getFallbackModel(): LanguageModel | null {
  if (!config.FALLBACK_MODEL) {
    return null;
  }
  const provider = getOpenRouterProvider();
  const modelName = config.FALLBACK_MODEL;
  logger.info({ model: modelName }, "Engaging OpenRouter intra-provider fallback model");
  return provider(modelName);
}
