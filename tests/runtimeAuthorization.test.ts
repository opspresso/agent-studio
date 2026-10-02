import { listModels, replaceModelRegistry } from "@/domain/llm/models";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NoopTrace, withTrace, type ModelRequest } from "@openai/agents";
import { createRunModel } from "@/application/runtime/model";
import { createRuntimeModelTask } from "@/application/runtime/modelTask";
import type { AgentDeps, RunAgentInput, RuntimeTurn } from "@/application/runtime/types";
import { createToolResultBudget, MAX_TOOL_RESULT_CHARS_PER_TURN } from "@/application/llm/toolResultBudget";
import { ImageRegistry } from "@/application/llm/agentAssembly";
import { DEFAULT_CALL_ROUTING_POLICY } from "@/domain/llm/callRouting";
import { ForbiddenError, AppError } from "@/application/errors";
import { contentChunk, FakeChannel } from "./fakeChannel";

const input: RunAgentInput = { agentName: "agent", model: "local/primary", fallbackModel: "local/fallback", messages: [] };
const request: ModelRequest = { input: "Hello", tools: [], handoffs: [], outputType: "text", tracing: false, modelSettings: {} };
const turn = (): RuntimeTurn => ({ number: 0, maxTurns: 4, finalTurn: false, outputCut: false, model: input.model,
  results: createToolResultBudget(MAX_TOOL_RESULT_CHARS_PER_TURN) });
const originalModels = listModels();
beforeEach(() => {
  replaceModelRegistry(["local/primary", "local/fallback"].map(id => ({
    id, displayName: id, family: "test", maker: "test", provider: "local", providerKind: "selfhosted",
    contextWindow: 32000, maxTokens: 8192, pricing: { inputPer1M: 0.1, outputPer1M: 0.1 },
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
  })));
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-02T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); replaceModelRegistry(originalModels); });
const deny = () => { throw new ForbiddenError("Caller permission revoked"); };

describe("runtime authorization before paid model attempts", () => {
  it.each([429, 502, 503])("does not fall back after authorization fails with HTTP %s", async status => {
    const channel = new FakeChannel([[contentChunk("must not run")]]);
    const authorizeExecution = vi.fn(async () => { throw new AppError("Authorization unavailable", status); });
    const model = createRunModel({ channel, authorizeExecution }, input, turn(), () => {});
    await expect(withTrace(new NoopTrace(), async () => {
      for await (const _event of model.getStreamedResponse(request)) { /* drain */ }
    })).rejects.toThrow("Authorization unavailable");
    expect(authorizeExecution).toHaveBeenCalledTimes(1);
    expect(channel.calls).toBe(0);
  });
  it.each(["response", "stream"] as const)("refuses %s before calling the provider", async mode => {
    const channel = new FakeChannel([[contentChunk("must not run")]]);
    const model = createRunModel({ channel, authorizeExecution: async () => deny() }, input, turn(), () => {});
    await expect(withTrace(new NoopTrace(), async () => {
      if (mode === "response") await model.getResponse(request);
      else for await (const _event of model.getStreamedResponse(request)) { /* drain */ }
    })).rejects.toThrow("Caller permission revoked");
    expect(channel.calls).toBe(0);
  });

  it.each(["response", "stream"] as const)("rechecks a revoked caller before the %s fallback", async mode => {
    let allowed = true;
    const unavailable = () => { allowed = false; throw Object.assign(new Error("Unavailable"), { status: 503 }); };
    const getModel = vi.fn(() => ({
      getResponse: async () => unavailable(),
      getStreamedResponse: async function* () { unavailable(); yield* []; },
    }));
    const authorizeExecution = vi.fn(async () => { if (!allowed) deny(); });
    const model = createRunModel({ channel: { getModel }, authorizeExecution }, input, turn(), () => {});
    await expect(withTrace(new NoopTrace(), async () => {
      if (mode === "response") await model.getResponse(request);
      else for await (const _event of model.getStreamedResponse(request)) { /* drain */ }
    })).rejects.toThrow("Caller permission revoked");
    expect(getModel).toHaveBeenCalledTimes(1);
    expect(authorizeExecution).toHaveBeenCalledTimes(2);
  });

  it("rechecks ModelTask attempts after an empty provider response", async () => {
    let allowed = true;
    const channel = new FakeChannel([[], [contentChunk("must not run")]]);
    const deps: AgentDeps = {
      channel: { getModel: async name => {
        const model = await channel.getModel(name);
        return { ...model, getResponse: async request => { const result = await model.getResponse(request); allowed = false; return result; } };
      } },
      authorizeExecution: vi.fn(async () => { if (!allowed) deny(); }),
      modelRoutingPolicy: { ...DEFAULT_CALL_ROUTING_POLICY, tiers: { fast: input.model } },
      callRouting: { decision: { choose: async () => { throw new Error("Disabled routing cannot make a decision call"); } },
        selectedDecisionModel: async () => undefined, canUseModel: async () => true },
    };
    const task = createRuntimeModelTask(deps, { ...input, parameters: { modelRouting: true } }, turn(), new ImageRegistry(), () => {});
    await expect(withTrace(new NoopTrace(), () => task({ purpose: "summary", prompt: "Summarize", image_ids: [] }))).rejects.toThrow();
    expect(channel.calls).toBe(1);
    expect(deps.authorizeExecution).toHaveBeenCalledTimes(2);
  });
});
