/**
 * evals/run.ts
 * Evaluation runner that executes benchmark scenarios against the pipeline
 * using an injectable FakeClock and replayed search cache for deterministic, free offline testing.
 * Writes detailed scorecard results to evals/results.json.
 */

import fs from "node:fs";
import path from "node:path";
import { FakeClock } from "../src/time/clock.js";
import { searchCache } from "../src/search/cache.js";
import { getDb } from "../src/memory/db.js";
import { saveMessage, saveTurn, saveClaims } from "../src/memory/ledger.js";
import { runTurn } from "../src/pipeline/index.js";
import { judgeScenario, type EvalScore, type ScenarioExpectations } from "./judge.js";
import type { Turn, SearchResult, Claim } from "../src/pipeline/types.js";

interface ScenarioFile {
  id: string;
  name: string;
  fakeNow: string;
  userTz: string;
  userMessage: string;
  seededTurns?: Turn[];
  seededClaims?: Claim[];
  searchFixtures?: Record<string, SearchResult[]>;
  expectations: ScenarioExpectations;
}

async function runEvals() {
  console.log("================================================================");
  console.log("   Search-Only Chat Agent - Benchmark Evaluation Suite (8 Scenarios)");
  console.log("================================================================\n");

  const scenariosDir = path.resolve("./evals/scenarios");
  if (!fs.existsSync(scenariosDir)) {
    console.error("Scenarios directory not found:", scenariosDir);
    process.exit(1);
  }

  const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith(".json"));
  console.log(`Discovered ${files.length} benchmark scenario(s).\n`);

  const results: EvalScore[] = [];

  // Run each scenario in an isolated test database
  const testDb = "./data/eval.db";
  const db = getDb(testDb);

  for (const file of files) {
    const raw = fs.readFileSync(path.join(scenariosDir, file), "utf-8");
    const scenario: ScenarioFile = JSON.parse(raw);

    console.log(`▶ Running Scenario [${scenario.id}]: ${scenario.name}`);

    // Clear tables for clean scenario isolation
    db.exec("DELETE FROM turns; DELETE FROM messages; DELETE FROM claims; DELETE FROM searches;");

    // 1. Setup deterministic FakeClock
    const clock = new FakeClock(scenario.fakeNow);

    // 2. Setup deterministic Search Cache replay fixtures
    if (scenario.searchFixtures) {
      searchCache.enableReplayMode(scenario.searchFixtures);
    } else {
      searchCache.disableReplayMode();
    }

    // 3. Seed historical turns and claims if defined
    const sessionId = `eval-${scenario.id}`;
    if (scenario.seededTurns) {
      for (const st of scenario.seededTurns) {
        saveMessage(sessionId, "user", st.userMessage, st.createdAt);
        saveMessage(sessionId, "assistant", st.assistantResponse, st.createdAt);
        saveTurn({ ...st, sessionId });
      }
    }
    if (scenario.seededClaims && scenario.seededClaims.length > 0) {
      saveClaims(scenario.seededClaims);
    }

    // 4. Run pipeline
    const startTime = performance.now();
    let assistantResponse = "";
    let searchesTriggered = 0;

    try {
      const turn = await runTurn(
        {
          sessionId,
          userMessage: scenario.userMessage,
          timezone: scenario.userTz,
          clock,
        },
        {
          onEvent: (event) => {
            if (event.type === "token") {
              assistantResponse += event.content;
            } else if (
              event.type === "status" &&
              event.message.toLowerCase().includes("searching")
            ) {
              searchesTriggered++;
            }
          },
        }
      );

      const latencyMs = Math.round(performance.now() - startTime);
      const searchCount = turn.searchQueries ? turn.searchQueries.length : searchesTriggered;

      // 5. Judge output
      const score = await judgeScenario(
        scenario.id,
        scenario.userMessage,
        turn.assistantResponse || assistantResponse,
        scenario.expectations,
        latencyMs,
        searchCount
      );

      results.push(score);
      console.log(
        `  ✓ Finished in ${latencyMs}ms | Correctness: ${score.correctnessScore} | Citations: ${score.citationScore} | Honesty: ${score.honestyScore} | Searches: ${score.searchCount} | Passed: ${score.passed ? "YES" : "NO"}`
      );
      if (score.notes.length > 0) {
        console.log(`    Notes: ${score.notes.join("; ")}`);
      }
    } catch (err: unknown) {
      const latencyMs = Math.round(performance.now() - startTime);
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ Execution failed (${errMsg})`);
      results.push({
        scenarioId: scenario.id,
        passed: false,
        correctnessScore: 0,
        citationScore: 0,
        honestyScore: 0,
        searchEfficiencyScore: 0,
        searchCount: 0,
        latencyMs,
        notes: [`Execution exception: ${errMsg}`],
      });
    } finally {
      searchCache.disableReplayMode();
      console.log("");
    }
  }

  // Summary Table
  console.log(
    "-----------------------------------------------------------------------------------------"
  );
  console.log("   Evaluation Benchmark Scorecard");
  console.log(
    "-----------------------------------------------------------------------------------------"
  );
  console.table(
    results.map((r) => ({
      Scenario: r.scenarioId,
      Status: r.passed ? "✅ PASS" : "❌ FAIL",
      Correctness: r.correctnessScore,
      Citations: r.citationScore,
      Honesty: r.honestyScore,
      Searches: r.searchCount,
      Latency: `${r.latencyMs}ms`,
    }))
  );

  const totalPassed = results.filter((r) => r.passed).length;
  console.log(`Total: ${totalPassed}/${results.length} scenarios passed.\n`);

  // Write evals/results.json
  const resultsPath = path.resolve("./evals/results.json");
  fs.writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        executedAt: new Date().toISOString(),
        totalScenarios: results.length,
        passedCount: totalPassed,
        results,
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`Saved detailed benchmark results to ${resultsPath}\n`);
}

runEvals().catch((err) => {
  console.error("Eval suite failed with error:", err);
  process.exit(1);
});
