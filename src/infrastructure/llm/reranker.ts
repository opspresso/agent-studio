import type { RerankerPort } from "@/domain/vector/types";
import { calculateRerankCost } from "@/domain/llm/models";

interface ResolvedRerankerModel {
  /** Registry id used for pricing and usage attribution. */
  id: string;
  /** Endpoint-native id sent on the wire. */
  wireId: string;
}

interface RerankerConfig {
  baseUrl: string;
  apiKey?: string;
  model: () => Promise<ResolvedRerankerModel> | ResolvedRerankerModel;
}

interface RerankResult {
  index?: unknown;
  relevance_score?: unknown;
}

function inputTokensOf(body: unknown): number {
  if (typeof body !== "object" || body === null) {
    return 0;
  }
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) {
    return 0;
  }
  const typedUsage = usage as { prompt_tokens?: unknown; total_tokens?: unknown };
  const tokens = typedUsage.prompt_tokens ?? typedUsage.total_tokens;
  return typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0 ? tokens : 0;
}

/** A catalog rerank must not hold the tools preparation stage indefinitely. */
const RERANKER_TIMEOUT_MS = 15_000;

async function waitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Rerank was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Reranking as served by vLLM's `/v1/rerank`. */
export function createReranker(config: RerankerConfig): RerankerPort {
  return {
    async rerank(query, documents, instruction, signal) {
      if (documents.length === 0) {
        return { scores: [] };
      }
      const timeout = AbortSignal.timeout(RERANKER_TIMEOUT_MS);
      const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const model = await waitWithSignal(Promise.resolve(config.model()), operationSignal);
      const headers = new Headers({ "content-type": "application/json" });
      if (config.apiKey) {
        headers.set("authorization", `Bearer ${config.apiKey}`);
      }
      const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/rerank`, {
        method: "POST",
        headers,
        signal: operationSignal,
        body: JSON.stringify({
          model: model.wireId,
          query,
          documents,
          top_n: documents.length,
          ...(instruction ? { instruction } : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(`Reranker returned HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      const results =
        typeof body === "object" && body !== null
          ? (body as { results?: unknown }).results
          : undefined;
      if (!Array.isArray(results) || results.length !== documents.length) {
        throw new Error(
          `Reranker returned ${Array.isArray(results) ? results.length : 0} scores for ${documents.length} documents`,
        );
      }
      const scores: Array<number | undefined> = new Array(documents.length);
      for (const result of results as RerankResult[]) {
        const index = result.index;
        const score = result.relevance_score;
        if (
          !Number.isInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= documents.length ||
          typeof score !== "number" ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 1 ||
          scores[index as number] !== undefined
        ) {
          throw new Error("Reranker returned an invalid result");
        }
        scores[index as number] = score;
      }
      if (scores.some((score) => score === undefined)) {
        throw new Error("Reranker returned an incomplete result");
      }
      const inputTokens = inputTokensOf(body);
      return {
        scores: scores as number[],
        usage: {
          model: model.id,
          inputTokens,
          costUsd: calculateRerankCost(model.id, inputTokens),
        },
      };
    },
  };
}
