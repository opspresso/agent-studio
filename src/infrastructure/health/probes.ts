import { readinessSql } from "@/infrastructure/db/client";

const LLM_TIMEOUT_MS = 2000;

/** A low-cost read that confirms the schema, credentials, and connectivity. */
export async function dbReachable(): Promise<void> {
  await readinessSql("SELECT 1 FROM items LIMIT 1");
}

/**
 * Any HTTP response from the OpenAI-compatible base means the channel is
 * reachable; only a network error or timeout counts as unreachable. No
 * completion is issued — this probes connectivity, not completion health.
 */
export async function llmReachable(
  loadChannelConfig: () => Promise<{ baseUrl: string; apiKey: string }>,
): Promise<void> {
  const { baseUrl, apiKey } = await loadChannelConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    await res.body?.cancel().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}
