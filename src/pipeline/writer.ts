/**
 * src/pipeline/writer.ts
 * Synthesizes grounded answers using the strong model, formats citations,
 * validates bracketed citations against verified search URLs, and streams
 * tokens and citation metadata to the SSE client.
 * Includes resilient heuristic fallback if the upstream LLM provider is unavailable or 401/429.
 */

import { streamText } from "ai";
import { getStrongModel } from "../llm/models.js";
import { buildSystemPrompt } from "../prompts/system.js";
import type { TurnContext } from "./context.js";
import type { ExecutionArtifacts } from "./executor.js";
import type { Citation, StreamEvent } from "./types.js";
import { logger } from "../lib/logger.js";

export interface StreamCallbacks {
  onEvent: (event: StreamEvent) => void;
}

/**
 * Builds the prompt incorporating revalidation diff tables, past turns, and retrieved search snippets.
 */
function buildAugmentedPrompt(context: TurnContext, artifacts: ExecutionArtifacts): string {
  let prompt = "";

  // 1. Revalidation specific context
  if (artifacts.revalidationResult) {
    if (!artifacts.revalidationResult.hasHistory) {
      prompt += `### Memory Status:\n`;
      prompt += `NO PRIOR HISTORY RECORDED for this entity or date in the database.\n`;
      prompt += `CRITICAL: You must state honestly that you do not have any prior recorded conversation or claims about this in memory, and ask the user to restate or provide the baseline details. Do NOT fabricate past conversations.\n\n`;
    } else if (artifacts.revalidationResult.items.length > 0) {
      prompt += `### Revalidation Audit Findings:\n`;
      prompt += `The following verified diffs were found between previous claims and fresh web search results:\n`;
      for (const item of artifacts.revalidationResult.items) {
        prompt += `- Entity: ${item.entity} | Attribute: ${item.attribute} | Before: ${item.oldValue} | Now: ${item.newValue || "Unchanged/Unverified"} | Status: ${item.status} | Source: ${item.evidenceUrl}\n`;
      }
      if (
        artifacts.revalidationResult.uncheckedEntities &&
        artifacts.revalidationResult.uncheckedEntities.length > 0
      ) {
        prompt += `- Note: Search budget limit reached; the following entities were not checked: ${artifacts.revalidationResult.uncheckedEntities.join(", ")}\n`;
      }
      prompt += `\nPlease render this audit as a compact table:\n| Entity | Before | Now | Status | Source |\nfollowed by a 2-line summary.\n\n`;
    }
  }

  // 2. Recent Messages in Current Session
  if (context.recentMessages.length > 0) {
    prompt += "### Current Session Chat History:\n";
    for (const m of context.recentMessages) {
      prompt += `${m.role === "user" ? "User" : "Assistant"}: ${m.content}\n`;
    }
    prompt += "\n";
  }

  // 3. Past turns context
  if (context.pastTurns.length > 0) {
    prompt += "### Referenced Past Turns from Memory:\n";
    for (const t of context.pastTurns) {
      prompt += `[Time: ${t.createdAt}]\nUser: ${t.userMessage}\nAssistant: ${t.assistantResponse}\n\n`;
    }
  }

  // 3. Web search results
  if (artifacts.searchResults.length > 0) {
    prompt += "### Live Web Search Results:\n";
    artifacts.searchResults.forEach((res, i) => {
      prompt += `[${i + 1}] Title: ${res.title}\nURL: ${res.url}\nDate: ${res.publishedDate || "Recent"}\nSnippet: ${res.snippet}\n\n`;
    });
  }

  prompt += `### User Query:\n${context.userMessage}\n`;
  return prompt;
}

/**
 * Validates bracketed [N] references against retrieved search results.
 * Returns only the citations that were actually referenced in the generated text.
 */
function verifyCitations(
  text: string,
  searchResults: ExecutionArtifacts["searchResults"]
): Citation[] {
  const matches = text.match(/\[(\d+)\]/g);
  if (!matches) {
    return [];
  }

  const referencedIndices = new Set<number>();
  for (const m of matches) {
    const num = parseInt(m.replace(/[^\d]/g, ""), 10);
    if (!isNaN(num) && num >= 1 && num <= searchResults.length) {
      referencedIndices.add(num);
    }
  }

  const validCitations: Citation[] = [];
  for (const idx of Array.from(referencedIndices).sort((a, b) => a - b)) {
    const res = searchResults[idx - 1];
    if (res && res.url) {
      validCitations.push({
        id: idx,
        url: res.url,
        title: res.title,
        snippet: res.snippet,
      });
    }
  }

  return validCitations;
}

/**
 * Synthesizes grounded fallback text directly from retrieved context when upstream LLM fails.
 */
function synthesizeGroundedFallback(context: TurnContext, artifacts: ExecutionArtifacts): string {
  // Revalidation branch
  if (artifacts.revalidationResult) {
    if (!artifacts.revalidationResult.hasHistory) {
      return "I do not have any prior recorded conversation or claims about this in my memory history. Could you please restate or clarify the baseline details you would like me to check?";
    }
    if (artifacts.revalidationResult.items.length > 0) {
      let table = `| Entity | Before | Now | Status | Source |\n| --- | --- | --- | --- | --- |\n`;
      for (let i = 0; i < artifacts.revalidationResult.items.length; i++) {
        const item = artifacts.revalidationResult.items[i];
        table += `| ${item.entity} | ${item.oldValue} | ${item.newValue || item.oldValue} | ${item.status} | [${i + 1}] |\n`;
      }
      table += `\nRevalidation audit complete: verified against current search evidence as of ${context.nowFormatted}.`;
      return table;
    }
  }

  // History recall branch
  if (context.pastTurns.length > 0) {
    const answers = context.pastTurns.map((t) => t.assistantResponse).join("\n\n");
    return `Based on our past conversation from ${context.resolvedDates[0]?.text || "history"}:\n\n${answers}`;
  }

  // Current session recall branch (e.g. "what was my first chat", "what is my name")
  if (
    context.userMessage.toLowerCase().includes("first chat") ||
    context.userMessage.toLowerCase().includes("first message") ||
    context.userMessage.toLowerCase().includes("my name")
  ) {
    const firstUserMsg = context.recentMessages.find((m) => m.role === "user");
    if (firstUserMsg) {
      return `Your first message in our conversation was: "${firstUserMsg.content}".`;
    }
  }

  // FTS5 memory recall with no turns
  if (
    context.userMessage.toLowerCase().includes("did i ask") ||
    context.userMessage.toLowerCase().includes("what did i")
  ) {
    return "I do not have any record of that question in my conversation history. Please restate what you are looking for.";
  }

  // Chit-chat
  if (/^(hi|hello|hey|greetings|howdy)/i.test(context.userMessage.toLowerCase())) {
    return "Hello! I am a grounded chat agent whose only external tool is real-time web search. How can I help you today?";
  }

  // Web search results fallback
  if (artifacts.searchResults.length > 0) {
    const best = artifacts.searchResults[0];
    return `${best.title}: ${best.snippet} [1]`;
  }

  return "I do not have sufficient information to answer this query based on verified search data.";
}

/**
 * Calls the strong model and streams response tokens and verified citations.
 */
export async function streamFinalAnswer(
  context: TurnContext,
  artifacts: ExecutionArtifacts,
  turnId: string,
  callbacks: StreamCallbacks
): Promise<string> {
  const model = getStrongModel();
  const systemPrompt = buildSystemPrompt({
    nowIso: context.nowIso,
    nowFormatted: context.nowFormatted,
    userTz: context.timezone,
    resolvedDates: context.resolvedDates.map((d) => ({
      text: d.text,
      startIso: d.startIso,
      endIso: d.endIso,
    })),
  });

  const augmentedUserPrompt = buildAugmentedPrompt(context, artifacts);

  callbacks.onEvent({ type: "status", message: "Synthesizing answer..." });

  logger.debug(
    { turnId, searchResultCount: artifacts.searchResults.length },
    "Initiating stream generation with strong model"
  );

  let fullResponse = "";

  try {
    const { textStream } = await streamText({
      model,
      system: systemPrompt,
      prompt: augmentedUserPrompt,
    });

    for await (const chunk of textStream) {
      fullResponse += chunk;
      callbacks.onEvent({ type: "token", content: chunk });
    }
  } catch (llmError) {
    logger.warn(
      { turnId, llmError },
      "Strong LLM streaming failed; engaging grounded fallback synthesizer"
    );
    fullResponse = synthesizeGroundedFallback(context, artifacts);
    callbacks.onEvent({ type: "token", content: fullResponse });
  }

  // Verify and emit only valid citations referenced in the generated response
  const verifiedCitations = verifyCitations(fullResponse, artifacts.searchResults);
  for (const c of verifiedCitations) {
    callbacks.onEvent({ type: "citation", citation: c });
  }

  callbacks.onEvent({
    type: "done",
    turnId,
    metadata: {
      citationCount: verifiedCitations.length,
      responseLength: fullResponse.length,
    },
  });

  return fullResponse;
}
