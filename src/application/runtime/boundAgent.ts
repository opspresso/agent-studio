import { Agent, type AgentOutputType, type Model, type RunStreamEvent } from "@openai/agents";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RunAgentInput } from "./types";
import type { PiiFilter } from "@/application/llm/pii";

type SdkAgent = Agent<unknown, AgentOutputType>;

interface Invocation {
  agent: SdkAgent;
  input: RunAgentInput;
  paused: boolean;
  completed: boolean;
  observe?: (event: RunStreamEvent) => void;
  filter?: PiiFilter;
}

/**
 * A stable SDK agent identity with per-invocation deployment resources.
 * SDK approvals are keyed by agent identity. Model/tool closures, in contrast,
 * must be isolated when the same bound specialist is invoked concurrently.
 */
export class BoundAgent extends Agent<unknown, AgentOutputType> {
  private readonly invocation: AsyncLocalStorage<Invocation>;
  private declarations?: SdkAgent;

  constructor(name: string) {
    const invocation = new AsyncLocalStorage<Invocation>();
    const model = (): Model => {
      const selected = invocation.getStore()?.agent.model;
      if (!selected || typeof selected === "string") throw new Error(`Agent '${name}' has no prepared invocation`);
      return selected;
    };
    super({ name, model: {
      getResponse: (request) => model().getResponse(request),
      getStreamedResponse: (request) => model().getStreamedResponse(request),
    } });
    this.invocation = invocation;
    // Runner reads guardrails as public properties, so resolve them per invocation too.
    Object.defineProperties(this, {
      inputGuardrails: { get: () => invocation.getStore()?.agent.inputGuardrails ?? this.declarations?.inputGuardrails ?? [] },
      outputGuardrails: { get: () => invocation.getStore()?.agent.outputGuardrails ?? this.declarations?.outputGuardrails ?? [] },
    });
  }

  current(): Invocation {
    const active = this.invocation.getStore();
    if (!active) throw new Error(`Agent '${this.name}' is outside its invocation`);
    return active;
  }

  bindDeclarations(agent: SdkAgent): void {
    // These declarations let RunState reconstruct the graph outside execution.
    // Running model/tools always resolve from AsyncLocalStorage below.
    this.tools = agent.tools;
    this.handoffs = agent.handoffs;
    this.outputType = agent.outputType;
    this.declarations = agent;
  }

  withInvocation<T>(agent: SdkAgent, input: RunAgentInput, execute: () => Promise<T>, observe?: (event: RunStreamEvent) => void, filter?: PiiFilter): Promise<T> {
    this.bindDeclarations(agent);
    return this.invocation.run({ agent, input, paused: false, completed: false, observe, filter }, execute);
  }

  override getSystemPrompt(...args: Parameters<SdkAgent["getSystemPrompt"]>): ReturnType<SdkAgent["getSystemPrompt"]> {
    return this.current().agent.getSystemPrompt(...args);
  }

  override getAllTools(...args: Parameters<SdkAgent["getAllTools"]>): ReturnType<SdkAgent["getAllTools"]> {
    return (this.invocation.getStore()?.agent ?? this.declarations)?.getAllTools(...args) ?? super.getAllTools(...args);
  }

  override getEnabledHandoffs(...args: Parameters<SdkAgent["getEnabledHandoffs"]>): ReturnType<SdkAgent["getEnabledHandoffs"]> {
    return (this.invocation.getStore()?.agent ?? this.declarations)?.getEnabledHandoffs(...args) ?? super.getEnabledHandoffs(...args);
  }
}
