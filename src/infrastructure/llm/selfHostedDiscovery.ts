/**
 * What a self-hosted OpenAI-compatible server is serving right now — the
 * declaration aid for the /models console. The base URL is operator
 * configuration (the same channel dispatch uses), not an address a user or a
 * model chose, so this is a plain fetch with a deadline rather than a guarded
 * one; loopback is exactly where LM Studio lives.
 *
 * `/v1/models` names the models and nothing else, so two enrichments fill in
 * what a declaration needs and the listing withholds:
 *
 * - **LM Studio** keeps a native catalog at `/api/v0/models` (origin-relative,
 *   not under `/v1`) carrying `max_context_length` and a `type` that tells an
 *   embedding model from a chat one. A server that is not LM Studio answers
 *   404, which is an answer — the enrichment is skipped, never raised.
 * - **vLLM** decorates its `/v1/models` entries with `max_model_len`; the
 *   configured endpoint supplies the type because each pooling server has one
 *   job (embedding or rerank).
 */

import type { ProviderChannelConfig } from "@/domain/settings/types";
import type { ModelType } from "@/domain/llm/models";

/** One model the channel serves, with what the serving stack says about it. */
export interface ServedSelfHostedModel {
  /** The serving stack's own name — what a declaration's `family` must be. */
  name: string;
  type: ModelType;
  /** From the stack where it states one (LM Studio, vLLM); absent otherwise. */
  contextWindow?: number;
  /** True when the stack types the model as vision-capable (LM Studio `vlm`). */
  vision?: boolean;
}

export interface SelfHostedModelChannel {
  channel: Pick<ProviderChannelConfig, "baseUrl" | "apiKey">;
  type: ModelType;
}

export interface ServedSelfHostedModelsView {
  served: ServedSelfHostedModel[] | null;
  servedError?: string;
}

const FETCH_TIMEOUT_MS = 10_000;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

interface LmStudioFacts {
  contextWindow?: number;
  type?: string;
}

/** LM Studio's native listing, keyed by model id; empty for any other server. */
async function lmStudioFacts(
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<Map<string, LmStudioFacts>> {
  const origin = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const facts = new Map<string, LmStudioFacts>();
  let response: Response;
  try {
    response = await fetchFn(`${origin}/api/v0/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return facts;
  }
  if (!response.ok) {
    return facts;
  }
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!Array.isArray(body?.data)) {
    return facts;
  }
  for (const entry of body.data) {
    const record = entry as { id?: unknown; max_context_length?: unknown; type?: unknown };
    if (typeof record.id !== "string" || record.id === "") {
      continue;
    }
    facts.set(record.id, {
      ...(isCount(record.max_context_length) ? { contextWindow: record.max_context_length } : {}),
      ...(typeof record.type === "string" ? { type: record.type } : {}),
    });
  }
  return facts;
}

export async function listServedSelfHostedModels(
  channel: Pick<ProviderChannelConfig, "baseUrl" | "apiKey">,
  type: ModelType = "text",
  fetchFn: typeof fetch = fetch,
): Promise<ServedSelfHostedModel[]> {
  const endpoint = `${channel.baseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetchFn(endpoint, {
    headers: {
      accept: "application/json",
      ...(channel.apiKey !== "" ? { Authorization: `Bearer ${channel.apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET ${endpoint} → ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error(`GET ${endpoint} → no "data" array in the response`);
  }
  const facts = await lmStudioFacts(channel.baseUrl, fetchFn);
  const served: ServedSelfHostedModel[] = [];
  for (const entry of body.data) {
    const record = entry as { id?: unknown; max_model_len?: unknown };
    if (typeof record.id !== "string" || record.id === "") {
      continue;
    }
    const fact = facts.get(record.id);
    const contextWindow = fact?.contextWindow ?? (isCount(record.max_model_len) ? record.max_model_len : undefined);
    served.push({
      name: record.id,
      type: fact?.type === "embeddings" ? "embedding" : type,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(fact?.type === "vlm" ? { vision: true } : {}),
    });
  }
  return served;
}

/** Keep healthy channel listings visible when a sibling endpoint is down. */
export async function listServedSelfHostedChannels(
  channels: readonly SelfHostedModelChannel[],
  fetchFn: typeof fetch = fetch,
): Promise<ServedSelfHostedModelsView> {
  const results = await Promise.allSettled(
    channels.map(({ channel, type }) => listServedSelfHostedModels(channel, type, fetchFn)),
  );
  const served = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const errors = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [`${channels[index]?.type ?? "unknown"}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : [],
  );
  return {
    served: results.some((result) => result.status === "fulfilled") ? served : null,
    ...(errors.length > 0 ? { servedError: errors.join("; ") } : {}),
  };
}
