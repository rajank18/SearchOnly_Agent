/**
 * src/config.ts
 * Parses and validates environment variables using Zod.
 * OpenRouter is the primary and sole LLM provider, with model-level failover.
 * Fails fast on startup with informative error messages if the OpenRouter key is missing.
 */

import { z } from "zod";

// Load local .env file natively if available in Node 20+
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // Ignore error if .env doesn't exist; process.env will be validated directly
}

const defaultApiKey =
  process.env.OPENROUTER_API_KEY ||
  process.env.OPENROUTER_KEY ||
  process.env.FALLBACK_API_KEY ||
  "";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3000),

    // Primary LLM Provider Settings (OpenRouter)
    OPENROUTER_API_KEY: z.string().default(defaultApiKey),
    OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
    FAST_MODEL: z
      .string()
      .default(process.env.FAST_MODEL || "nvidia/nemotron-3.5-super-vl:free"),
    STRONG_MODEL: z
      .string()
      .default(process.env.STRONG_MODEL || "nvidia/nemotron-3.5-super-vl:free"),
    FALLBACK_MODEL: z
      .string()
      .default(process.env.FALLBACK_MODEL || "nvidia/nemotron-3.5-lightning:free"),

    // Search Settings
    SEARCH_PROVIDERS: z
      .string()
      .default("tavily,exa")
      .transform((val) =>
        val
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      ),
    TAVILY_API_KEY: z.string().optional(),
    EXA_API_KEY: z.string().optional(),

    // Limits & Defaults
    MAX_SEARCHES_PER_TURN: z.coerce.number().int().positive().default(6),
    MAX_PARALLEL_SEARCHES: z.coerce.number().int().positive().default(5),
    SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    DEFAULT_TIMEZONE: z.string().default("Asia/Kolkata"),
    DB_PATH: z.string().default("./data/agent.db"),
  })
  .superRefine((data, ctx) => {
    // In test environment, allow mock/omitted keys
    if (data.NODE_ENV === "test") {
      return;
    }

    if (!data.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENROUTER_API_KEY"],
        message:
          "Missing OPENROUTER_API_KEY. " +
          "Get a free API key at https://openrouter.ai/keys and add it to your .env file.",
      });
    }
  });

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("\n❌ Configuration Error: Missing or invalid environment variables:");
    for (const issue of result.error.issues) {
      console.error(`   - [${issue.path.join(".") || "GLOBAL"}]: ${issue.message}`);
    }
    console.error(
      "\nPlease create or update your .env file using .env.example as a reference.\n"
    );
    throw new Error("Invalid application configuration");
  }
  return result.data;
}

export type AppConfig = z.infer<typeof envSchema>;
export const config: AppConfig = loadConfig();
