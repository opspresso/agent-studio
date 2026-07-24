/**
 * Minimal client for the external-agent "send one message" smoke test.
 * Sends a single non-streaming OpenAI-compatible chat completion over plain
 * `fetch` and returns the assistant text.
 */

import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { readBodyText } from "@/lib/httpBody";

const TIMEOUT_MS = 60_000;
const MAX_AGENT_RESPONSE_BYTES = 2_000_000;

/**
 * External agents carry no stored model id, so a placeholder is sent. Most
 * OpenAI-compatible agent endpoints route by their own configured model and
 * ignore this value; endpoints that require a specific model will surface that
 * as the smoke-test error.
 */
const SMOKE_TEST_MODEL = "default";

export type SendMessageResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export async function sendAgentMessage(
  url: string,
  headers: Record<string, string>,
  message: string,
): Promise<SendMessageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchPublicUrl(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SMOKE_TEST_MODEL,
        messages: [{ role: "user", content: message }],
        stream: false,
      }),
      signal: controller.signal,
    });
    const responseText = await readBodyText(res, MAX_AGENT_RESPONSE_BYTES);
    if (!res.ok) {
      const detail = responseText.slice(0, 500);
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail}` : ""}` };
    }
    const data = JSON.parse(responseText) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      return { ok: false, error: "No assistant message in response" };
    }
    return { ok: true, text };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Request timed out after ${TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Request failed" };
  } finally {
    clearTimeout(timer);
  }
}
