import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { withTimeout } from "@/shared/withTimeout";

const DB_TIMEOUT_MS = 2000;
const LLM_TIMEOUT_MS = 2000;

/** A low-cost GetItem that confirms the table, credentials, and connectivity. */
export async function dbReachable(): Promise<void> {
  await withTimeout(
    getDocumentClient().send(new GetCommand({ TableName: getTableName(), Key: keys.settings() })),
    DB_TIMEOUT_MS,
  );
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
