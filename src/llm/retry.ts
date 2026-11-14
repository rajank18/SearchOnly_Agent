/**
 * src/llm/retry.ts
 * Implements exponential backoff retry with jitter and provider failover
 * for LLM calls on 429 and 5xx errors.
 */

import { logger } from "../lib/logger.js";
import { getFallbackModel } from "./models.js";
import type { LanguageModel } from "ai";

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
}

/**
 * Checks if an error is transient / retryable (rate limit 429, 503, 500, or network socket timeout).
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  const msg = String(error).toLowerCase();
  const status =
    (error as { status?: number; statusCode?: number })?.status ||
    (error as { status?: number; statusCode?: number })?.statusCode;

  return (
    status === 429 ||
    status === 500 ||
    status === 503 ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("quota") ||
    msg.includes("500") ||
    msg.includes("503") ||
    msg.includes("timeout") ||
    msg.includes("econnreset")
  );
}

/**
 * Executes an LLM operation with exponential backoff + jitter and transparent failover to fallback model if exhausted.
 */
export async function withLlmRetry<T>(
  operation: (model?: LanguageModel) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let delay = opts.initialDelayMs ?? 1000;
  const backoffFactor = opts.backoffFactor ?? 2;

  let lastError: unknown;

  // Try primary model with retries
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === maxAttempts) {
        break;
      }

      // Add 0-250ms random jitter to prevent thundering herd
      const jitter = Math.floor(Math.random() * 250);
      const totalDelay = delay + jitter;

      logger.warn(
        { attempt, totalDelay, error },
        `LLM call encountered retryable error. Retrying in ${totalDelay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, totalDelay));
      delay *= backoffFactor;
    }
  }

  // Attempt fallback provider if configured
  const fallbackModel = getFallbackModel();
  if (fallbackModel) {
    logger.warn({ error: lastError }, "Primary LLM exhausted; attempting fallback model");
    try {
      return await operation(fallbackModel);
    } catch (fallbackError) {
      logger.error({ fallbackError }, "Fallback LLM invocation also failed");
      throw fallbackError;
    }
  }

  throw lastError;
}
