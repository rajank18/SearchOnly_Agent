/**
 * src/lib/logger.ts
 * Configures the centralized pino logger and provides a stage-timing utility
 * to record and log execution latencies across each turn pipeline phase.
 */

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});

/**
 * Measures the execution time of an asynchronous stage and logs start/end latencies.
 */
export async function timeStage<T>(
  stageName: string,
  fn: () => Promise<T>,
  metadata: Record<string, unknown> = {}
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  logger.debug({ stage: stageName, ...metadata }, `Stage started: ${stageName}`);
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    logger.info({ stage: stageName, durationMs, ...metadata }, `Stage completed: ${stageName}`);
    return { result, durationMs };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    logger.error(
      { stage: stageName, durationMs, error, ...metadata },
      `Stage failed: ${stageName}`
    );
    throw error;
  }
}
