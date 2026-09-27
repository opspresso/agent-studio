import { MaxTurnsExceededError, ModelBehaviorError, RunState } from "@openai/agents";
import { ValidationError } from "@/application/errors";
import { describeImageInputReject } from "@/domain/llm/models";
import { hasImageParts, type EngineChunk } from "@/domain/llm/types";
import { toAgentInput, maskMessage } from "./messages";
import { createStudioRunner } from "./runner";
import type { AgentDeps, RunAgentInput } from "./types";
import type { RuntimeEmitter } from "./output";
import { compileAgent, restoreHandoffGraph, snapshotGraph, type AgentGraph } from "./agent";
import { approvalId } from "./session";
import { withNativeTracing } from "./tracing";

/** SDK Runner is the only owner of model/tool turns. This generator carries Studio output. */
export async function* runAgent(deps: AgentDeps, input: RunAgentInput): AsyncGenerator<EngineChunk> {
  if (input.parameters?.modelRouting !== true && input.messages.some(hasImageParts)) {
    const refusal = describeImageInputReject(input.model);
    if (refusal) throw new ValidationError(refusal);
  }
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const restored = input.runtime?.checkpoint?.input;
  const activeInput: RunAgentInput = restored
    ? { ...restored, now: restored.now ? new Date(restored.now) : undefined, runtime: input.runtime, signal }
    : { ...input, signal };
  let finished = false;
  let producer: Promise<void> | undefined;
  const waiting = new Set<() => void>();
  let emittedSinceDemand = false;
  const stream = new ReadableStream<EngineChunk>({
    start(sink) {
      const emit: RuntimeEmitter = (chunk) => {
        if (!signal.aborted) { emittedSinceDemand = true; sink.enqueue(chunk); }
      };
      emit.ready = async () => {
        while (emittedSinceDemand && !signal.aborted) {
          await new Promise<void>((resolve) => {
            const resume = () => { signal.removeEventListener("abort", resume); waiting.delete(resume); resolve(); };
            waiting.add(resume);
            signal.addEventListener("abort", resume, { once: true });
          });
        }
        signal.throwIfAborted();
      };
      producer = withNativeTracing(deps.onSdkSpan, async () => {
        const graph: AgentGraph = { close: [], persistent: Boolean(input.runtime), saved: input.runtime?.checkpoint?.graph };
        const maxTurns = Math.max(0, activeInput.maxTurn ?? 50);
        try {
          signal.throwIfAborted();
          if (input.runtime) graph.history = await input.runtime.session.getItems();
          if (maxTurns === 0) {
            emit({ warning: turnLimitWarning(input, false) });
            emit({ finishReason: "turn-limit" });
            return;
          }
          const { agent, filter, observe } = compileAgent(deps, { ...activeInput, maxTurn: maxTurns }, emit, graph, input.runtime?.filter);
          for (const warning of input.runtime?.warnings ?? []) emit({ warning });
          let runInput: ReturnType<typeof toAgentInput> | RunState<unknown, typeof agent> = toAgentInput(filter ? activeInput.messages.map((message) => maskMessage(filter, message)) : activeInput.messages);
          if (input.runtime?.checkpoint) {
            await restoreHandoffGraph(agent, graph);
            const state = await RunState.fromString(agent, input.runtime.checkpoint.state);
            const pending = state.getInterruptions();
            for (const decision of input.runtime.decisions ?? []) {
              const item = pending.find((entry) => approvalId(entry) === decision.id);
              if (!item) throw new ValidationError("The stored approval no longer matches its SDK run");
              if (decision.approve) state.approve(item); else state.reject(item);
            }
            runInput = state;
          }
          const result = await createStudioRunner(deps.channel).run(
            agent,
            runInput,
            { stream: true, maxTurns, signal, ...(input.runtime && !input.runtime.checkpoint ? { session: input.runtime.session } : {}) },
          );
          for await (const event of result) observe(event);
          await result.completed;
          signal.throwIfAborted();
          if (input.runtime) {
            const approvals = await input.runtime.commit(activeInput, result.state, result.history, snapshotGraph(graph));
            if (approvals.length) emit({ approval: { pending: true } });
          }
          const turn = graph.activeTurn;
          if (!input.runtime && result.interruptions.length && turn?.resources?.imagesUsed) {
            emit({ warning: `${turn.resources.imagesUsed} image(s) tools returned this turn were delivered, but the model will not see them on the next run: the run ends here for the application to act.` });
          }
          if (turn?.finalTurn) {
            emit({ warning: turnLimitWarning(input, turn.answered === true) });
            emit({ finishReason: "turn-limit" });
          } else if (turn?.outputCut) emit({ finishReason: "output-limit" });
          else emit({ done: true });
        } catch (error) {
          if (signal.aborted) sink.error(signal.reason);
          else if (graph.activeTurn?.outputCut && error instanceof ModelBehaviorError) emit({ finishReason: "output-limit" });
          else if (error instanceof MaxTurnsExceededError) {
            emit({ warning: turnLimitWarning(input, false) });
            emit({ finishReason: "turn-limit" });
          } else emit({ error: error instanceof Error ? error.message || "unknown error" : String(error) });
        } finally {
          await Promise.all(graph.close.map((close) => close()));
          finished = true;
          if (!signal.aborted) sink.close();
        }
      });
    },
    pull() { emittedSinceDemand = false; for (const resume of waiting) resume(); },
    async cancel() { controller.abort("runtime consumer detached"); for (const resume of waiting) resume(); await producer; },
  }, { highWaterMark: 0 });
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      yield next.value;
    }
  } finally {
    if (!finished) await reader.cancel();
    reader.releaseLock();
  }
}

function turnLimitWarning(input: RunAgentInput, answered: boolean): string {
  const limit = input.maxTurn ?? 50;
  return answered
    ? `The run reached its turn limit (${limit} turns); the last turn was answered from what it already had, with no tools offered.`
    : `The run stopped at its turn limit (${limit} turns) before the model finished answering.`;
}
