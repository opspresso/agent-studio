import type { RerankerPort } from "@/domain/vector/types";

interface RerankerConfig {
  baseUrl: string;
  apiKey?: string;
  model: () => Promise<string> | string;
}

interface RerankResult {
  index?: unknown;
  relevance_score?: unknown;
}

/** A catalog rerank must not hold the tools preparation stage indefinitely. */
const RERANKER_TIMEOUT_MS = 15_000;

/** Reranking as served by vLLM's `/v1/rerank`. */
export function createReranker(config: RerankerConfig): RerankerPort {
  return {
    async rerank(query, documents, instruction) {
      if (documents.length === 0) {
        return [];
      }
      const headers = new Headers({ "content-type": "application/json" });
      if (config.apiKey) {
        headers.set("authorization", `Bearer ${config.apiKey}`);
      }
      const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/rerank`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(RERANKER_TIMEOUT_MS),
        body: JSON.stringify({
          model: await config.model(),
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
          scores[index as number] !== undefined
        ) {
          throw new Error("Reranker returned an invalid result");
        }
        scores[index as number] = score;
      }
      if (scores.some((score) => score === undefined)) {
        throw new Error("Reranker returned an incomplete result");
      }
      return scores as number[];
    },
  };
}
