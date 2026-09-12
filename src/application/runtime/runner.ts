import { Runner, type ModelProvider } from "@openai/agents";

/** Local execution never enables the SDK's default OpenAI trace exporter. */
export function createStudioRunner(modelProvider: ModelProvider): Runner {
  return new Runner({
    modelProvider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    modelSettings: { store: false, preserveRawUsage: true },
  });
}
