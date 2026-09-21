/**
 * A one-shot "does this model answer" probe for the /models console. Text models
 * use a small completion and image models generate through the image channel;
 * rerank models use their injected specialized-endpoint probe. It reports an
 * endpoint failure as a result rather than throwing, because turning failure
 * into a report is this function's job.
 *
 * A returned completion is success even with empty content: a reasoning model
 * may spend the whole token budget on hidden reasoning and finish with nothing
 * to say, which still proves the model answers here.
 *
 * Deliberately outside the run bracket: no usage row, no cost guard, no
 * concurrency slot. This is an admin diagnostic, not a run.
 */

import { ValidationError } from "@/application/errors";
import { withTrace, NoopTrace, type ModelProvider } from "@openai/agents";
import { getModelConfig, modelType } from "@/domain/llm/models";

export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export type TestModel = (modelId: string) => Promise<ModelTestResult>;

export interface TestModelDeps {
  testImage?: (modelId: string, signal: AbortSignal) => Promise<void>;
  testReranker?: (modelId: string, signal: AbortSignal) => Promise<void>;
}

const TEST_TIMEOUT_MS = 15_000;
const IMAGE_TEST_TIMEOUT_MS = 120_000;

export function createTestModel(models: ModelProvider, deps: TestModelDeps = {}): TestModel {
  return async (modelId) => {
    // Enabled or not is irrelevant — the point is testing a model *before*
    // enabling it — but an id the registry cannot price is a caller mistake,
    // not a test finding.
    const model = getModelConfig(modelId);
    if (model === undefined) {
      throw new ValidationError(`Unknown model "${modelId}"`);
    }
    const type = modelType(model);
    if (type !== "text" && type !== "decisions" && type !== "image" && type !== "rerank") {
      throw new ValidationError(
        `${type[0]?.toUpperCase()}${type.slice(1)} model cannot be tested through chat completion: ${modelId}`,
      );
    }
    if (type === "rerank" && !deps.testReranker) {
      throw new ValidationError(`The reranker endpoint is not configured: ${modelId}`);
    }
    if (type === "image" && !deps.testImage) {
      throw new ValidationError(`The image endpoint is not configured: ${modelId}`);
    }
    const startedAt = Date.now();
    try {
      const signal = AbortSignal.timeout(type === "image" ? IMAGE_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS);
      if (type === "rerank") {
        await deps.testReranker!(modelId, signal);
      } else if (type === "image") {
        await deps.testImage!(modelId, signal);
      } else {
        await withTrace(new NoopTrace(), async () => (await models.getModel(modelId)).getResponse({
          input: "ping", modelSettings: { maxTokens: 16, store: false },
          tools: [], handoffs: [], outputType: "text", tracing: false, signal,
        }));
      }
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
