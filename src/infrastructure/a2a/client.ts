/**
 * Outbound A2A client for registry agents with `protocol: "a2a"`.
 * Resolves the Agent Card from the stored URL, sends one blocking
 * `message/send`, and extracts the reply text from the returned Message or
 * Task (artifacts take precedence over the final status message, which some
 * remote agents use to repeat or summarize artifact content).
 */

import type { Message, Part, Task } from "@a2a-js/sdk";
import { A2AClient } from "@a2a-js/sdk/client";

export type A2aSendResult = { ok: true; text: string } | { ok: false; error: string };

const AGENT_CARD_SUFFIX = "/.well-known/agent-card.json";
const TIMEOUT_MS = 120_000;

/** Accepts either the card URL itself or the agent base URL. */
export function normalizeAgentCardUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith(AGENT_CARD_SUFFIX) ? trimmed : `${trimmed}${AGENT_CARD_SUFFIX}`;
}

function partsText(parts: Part[]): string {
  return parts.map((part) => (part.kind === "text" ? part.text : "")).join("");
}

export function extractA2aText(result: Message | Task): string {
  if (result.kind === "message") {
    return partsText(result.parts);
  }
  const artifactText = (result.artifacts ?? [])
    .map((artifact) => partsText(artifact.parts))
    .join("");
  if (artifactText) {
    return artifactText;
  }
  if (result.status.message) {
    const statusText = partsText(result.status.message.parts);
    if (statusText) {
      return statusText;
    }
  }
  for (const message of [...(result.history ?? [])].reverse()) {
    if (message.role === "agent") {
      const text = partsText(message.parts);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

export async function sendA2aMessage(
  url: string,
  headers: Record<string, string>,
  message: string,
): Promise<A2aSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const fetchImpl: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });

  try {
    const client = await A2AClient.fromCardUrl(normalizeAgentCardUrl(url), { fetchImpl });
    const response = await client.sendMessage({
      message: {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: message }],
      },
      configuration: { blocking: true, acceptedOutputModes: ["text/plain"] },
    });
    if ("error" in response) {
      return { ok: false, error: `A2A error ${response.error.code}: ${response.error.message}` };
    }
    const text = extractA2aText(response.result);
    if (!text) {
      const state = response.result.kind === "task" ? response.result.status.state : "message";
      return { ok: false, error: `A2A reply contained no text (state: ${state})` };
    }
    return { ok: true, text };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Request timed out after ${TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: error instanceof Error ? error.message : "A2A request failed" };
  } finally {
    clearTimeout(timer);
  }
}
