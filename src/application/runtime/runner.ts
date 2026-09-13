import { Runner, type ModelProvider, type RunConfig } from "@openai/agents";
import { nativeTracingEnabled } from "./tracing";

export const MAX_FUNCTION_TOOL_CONCURRENCY = 5;

/** Local execution never enables the SDK's default OpenAI trace exporter. */
export function createStudioRunner(modelProvider: ModelProvider): Runner {
  return new Runner(studioRunConfig(modelProvider));
}

export function studioRunConfig(modelProvider: ModelProvider): Partial<RunConfig> {
  return {
    modelProvider,
    tracingDisabled: !nativeTracingEnabled(),
    traceIncludeSensitiveData: false,
    modelSettings: { store: false, preserveRawUsage: true },
    toolExecution: { maxFunctionToolConcurrency: MAX_FUNCTION_TOOL_CONCURRENCY, preApprovalInputGuardrails: true },
  };
}
