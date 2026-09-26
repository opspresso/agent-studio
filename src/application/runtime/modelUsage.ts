import { calculateCost } from "@/domain/llm/models";
import type { UsageInfo } from "@/domain/llm/types";

export interface ResponseUsage {
  usage: { inputTokens: number; outputTokens: number; inputTokensDetails?: Record<string, number> | Record<string, number>[]; outputTokensDetails?: Record<string, number> | Record<string, number>[] };
  rawUsage?: Record<string, unknown>;
}

/** Preserve provider billing and token detail for every native model call. */
export function modelResponseUsage(model: string, response: ResponseUsage): UsageInfo {
  const { inputTokens, outputTokens } = response.usage;
  const sum = (details: Record<string, number> | Record<string, number>[] | undefined, key: string) =>
    Array.isArray(details) ? details.reduce((total, entry) => total + (entry[key] ?? 0), 0) : details?.[key] ?? 0;
  const cachedTokens = sum(response.usage.inputTokensDetails, "cached_tokens");
  const reasoningTokens = sum(response.usage.outputTokensDetails, "reasoning_tokens");
  const billed = response.rawUsage?.cost ?? response.rawUsage?.cost_usd;
  return { model, inputTokens, outputTokens,
    costUsd: typeof billed === "number" && Number.isFinite(billed) && billed >= 0
      ? billed : calculateCost(model, { inputTokens, outputTokens, cachedTokens }),
    ...(cachedTokens > 0 ? { cachedTokens } : {}), ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}
