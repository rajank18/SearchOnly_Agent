/**
 * src/llm/validate.ts
 * Verifies configured OpenRouter model IDs against the live OpenRouter catalog on startup.
 * Fails fast with an informative error if a configured model ID has retired or rotated.
 */

import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export async function verifyModelsOnStartup(): Promise<void> {
  // Skip during unit tests
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const configuredModels = [
    { key: "FAST_MODEL", id: config.FAST_MODEL },
    { key: "STRONG_MODEL", id: config.STRONG_MODEL },
    { key: "FALLBACK_MODEL", id: config.FALLBACK_MODEL },
  ].filter((m) => Boolean(m.id));

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status },
        "OpenRouter models catalog check returned non-200; skipping startup validation"
      );
      return;
    }

    const data = (await res.json()) as { data?: Array<{ id: string }> };
    if (!data.data || !Array.isArray(data.data)) {
      return;
    }

    const availableIds = new Set(data.data.map((m) => m.id));
    const availableFreeModels = data.data
      .map((m) => m.id)
      .filter((id) => id.endsWith(":free"))
      .slice(0, 8);

    const invalid = configuredModels.filter((m) => !availableIds.has(m.id));

    if (invalid.length > 0) {
      const errorLines = invalid
        .map(
          (m) =>
            `   - [${m.key}]: Model ID "${m.id}" was not found on OpenRouter.\n` +
            `     Note: OpenRouter free models rotate, rename, or retire over time.`
        )
        .join("\n");

      const suggestionLines = availableFreeModels.map((id) => `   - ${id}`).join("\n");

      const fullMessage =
        `\n❌ Startup Check Failed: Invalid or retired OpenRouter model ID:\n` +
        `${errorLines}\n\n` +
        `Active free models currently detected on OpenRouter include:\n` +
        `${suggestionLines}\n\n` +
        `Please update FAST_MODEL, STRONG_MODEL, or FALLBACK_MODEL in your .env file.\n`;

      console.error(fullMessage);
      throw new Error("Startup model verification failed: invalid model ID configured.");
    }

    logger.info(
      {
        fast: config.FAST_MODEL,
        strong: config.STRONG_MODEL,
        fallback: config.FALLBACK_MODEL,
      },
      "Verified OpenRouter model configuration against live catalog"
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("Startup model verification failed")) {
      throw err;
    }
    logger.warn({ err }, "Could not reach OpenRouter models endpoint; proceeding with configured models");
  }
}
