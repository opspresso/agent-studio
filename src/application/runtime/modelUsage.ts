import { calculateCost } from "@/domain/llm/models";
import type { UsageInfo } from "@/domain/llm/types";
import type { ModelResponse } from "@openai/agents";

/** Reasoning alone is not a final answer or an executable tool request. */
export function modelResponseHasOutput(response: Pick<ModelResponse, "output">): boolean {
  return !response.output.every(item => {
    if (item.type === "reasoning") return true;
    if (item.type !== "message") return false;
    if (typeof item.content === "string") return !item.content.trim();
    return item.content.every(part => part.type === "output_text" ? !part.text.trim()
      : part.type === "refusal" ? !part.refusal.trim() : false);
  });
}

/** Some providers report stop after spending the output budget entirely on reasoning. */
export function modelResponseIsTruncated(response: Pick<ModelResponse, "output" | "providerData"> & {usage: Pick<ModelResponse["usage"], "outputTokens">}, maxTokens?: number): boolean {
  if (response.providerData?.choices?.[0]?.finish_reason === "length") return true;
  return maxTokens !== undefined && maxTokens > 0 && response.usage.outputTokens >= maxTokens && !modelResponseHasOutput(response);
}

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
