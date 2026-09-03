/**
 * A one-shot "does this model answer" probe for the /models console. It sends
 * the cheapest possible completion through the real channel — provider
 * resolution, base URL, API key and wire-id rewriting are exactly what the
 * probe exists to exercise — and reports failure as a result rather than
 * throwing, because turning failure into a report is this function's job.
 *
 * A returned completion is success even with empty content: a reasoning model
 * may spend the whole token budget on hidden reasoning and finish with nothing
 * to say, which still proves the model answers here.
 *
 * Deliberately outside the run bracket: no usage row, no cost guard, no
 * concurrency slot. This is an admin diagnostic, not a run.
 */

import { ValidationError } from "@/application/errors";
import type { LlmChannel } from "@/domain/llm/channel";
import { getModelConfig, modelType } from "@/domain/llm/models";

export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export type TestModel = (modelId: string) => Promise<ModelTestResult>;

const TEST_TIMEOUT_MS = 15_000;

export function createTestModel(channel: LlmChannel): TestModel {
  return async (modelId) => {
    // Enabled or not is irrelevant — the point is testing a model *before*
    // enabling it — but an id the registry cannot price is a caller mistake,
    // not a test finding.
    const model = getModelConfig(modelId);
    if (model === undefined) {
      throw new ValidationError(`Unknown model "${modelId}"`);
    }
    const type = modelType(model);
    if (type === "embedding" || type === "reranker") {
      throw new ValidationError(
        `${type === "embedding" ? "Embedding" : "Reranker"} model cannot be tested through chat completion: ${modelId}`,
      );
    }
    const startedAt = Date.now();
    try {
      await channel.chatCompletion({
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 16,
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
