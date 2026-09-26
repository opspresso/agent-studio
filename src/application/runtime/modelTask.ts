import { withCustomSpan, withGenerationSpan, type ModelRequest } from "@openai/agents";
import { CALL_PURPOSES, type CallPurpose, type CallRoutingEvent } from "@/domain/llm/callRouting";
import type { UsageInfo } from "@/domain/llm/types";
import { imageDataUrl } from "@/domain/llm/types";
import { createCallModelRouter } from "@/application/llm/callModelRouter";
import type { ImageRegistry } from "@/application/llm/agentAssembly";
import type { AgentDeps, RunAgentInput } from "./types";
import type { RuntimeTurn } from "./model";
import type { RuntimeEmitter } from "./output";
import { modelResponseUsage } from "./modelUsage";

/** Focused inference inside the admitted Run, with no tools, credentials or second Agent loop. */
export function createRuntimeModelTask(deps: AgentDeps, input: RunAgentInput, turn: RuntimeTurn, images: ImageRegistry, emit: RuntimeEmitter) {
  const state = turn.routing ??= { calls: 0, spentUsd: 0, failures: {} };
  async function record(usage: UsageInfo) {
    emit({ usage });
    await deps.recordUsage?.({ ...usage, agentName: input.agentName, model: usage.model! });
  }
  return async (args: Record<string, unknown>) => {
    if (!deps.callRouting || !input.parameters?.modelRouting) throw new Error("ModelTask is not configured");
    if (!CALL_PURPOSES.includes(args.purpose as CallPurpose) || typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("Invalid ModelTask request");
    const ids = args.image_ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !images.get(id))) throw new Error("ModelTask image is not available in this run");
    const selectedImages = ids.map((id) => images.get(id as string)!);
    const events: CallRoutingEvent[] = [];
    return withCustomSpan(async (span) => {
      // Only routing metadata enters this span; prompt and answers remain out of trace storage.
      span.spanData.data = { routing: events };
      const router = createCallModelRouter(deps.callRouting!, input.parameters!.modelRouting!, input.model,
        state, (event) => events.push(event), record);
      const purpose = args.purpose as CallPurpose;
      const prompt = `${purpose === "classification" ? "Return a JSON object or array. " : ""}${args.prompt as string}`;
      const result = await router.execute({ purpose, prompt, imageCount: selectedImages.length,
        ...(typeof args.model === "string" && args.model ? { model: args.model } : {}),
        maxOutputTokens: input.parameters?.maxTokens ?? 2_048,
      }, async (model) => withGenerationSpan(async (generation) => {
        generation.spanData.model = model;
        const request: ModelRequest = {
          input: selectedImages.length ? [{ type: "message", role: "user", content: [
            { type: "input_text", text: prompt }, ...selectedImages.map((image) => ({ type: "input_image" as const, image: imageDataUrl(image), detail: "auto" as const })),
          ] }] : prompt,
          tools: [], handoffs: [], outputType: "text", tracing: false, signal: input.signal,
          modelSettings: { maxTokens: input.parameters?.maxTokens ?? 2_048,
            ...(purpose === "reasoning" ? { reasoning: { effort: "high" } } : {}),
          },
        };
        const native = await (await deps.channel.getModel(model)).getResponse(request);
        const usage = modelResponseUsage(model, native);
        generation.spanData.usage = { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_usd: usage.costUsd };
        // Bill every successful paid response, including a subsequently rejected answer.
        await record(usage);
        const text = native.output.flatMap((item) => item.type !== "message" ? [] : typeof item.content === "string" ? [item.content] : item.content.flatMap((part) => part.type === "output_text" ? [part.text] : [])).join("\n");
        const finish = (native.providerData?.choices as Array<{ finish_reason?: string }> | undefined)?.[0]?.finish_reason;
        return { text, usage, truncated: finish === "length" };
      }), input.signal);
      return { text: result.text };
    }, { data: { name: "model-routing" } });
  };
}
