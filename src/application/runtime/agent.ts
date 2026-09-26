import { Agent, Handoff, RunInputItem, RunContext, getCurrentSpan, type AgentOutputType, type JsonSchemaDefinition, type AgentInputItem } from "@openai/agents";
import { randomUUID } from "node:crypto";
import { ValidationError } from "@/application/errors";
import { assembleAgentRun, AGENT_TASK_SCHEMA, type ImageHandle, type ImageSequence } from "@/application/llm/agentAssembly";
import { createToolResultBudget, MAX_TOOL_RESULT_CHARS_PER_TURN } from "@/application/llm/toolResultBudget";
import { PiiFilter } from "@/application/llm/pii";
import { hasImageParts } from "@/domain/llm/types";
import { describeImageInputReject } from "@/domain/llm/models";
import { createRunModel, type RuntimeTurn, type RuntimeCallIds } from "./model";
import { createRuntimeTools, claimToolSlot, waitForSlot } from "./tools";
import { toAgentInput, conversationMessages } from "./messages";
import { buildTransferTranscript } from "./transcript";
import { studioRunConfig } from "./runner";
import { writeToolResult, type RuntimeEmitter } from "./output";
import type { AgentDeps, AgentTask, RunAgentInput, PreparedAgent } from "./types";
import { BoundAgent } from "./boundAgent";
import { createSdkOutput } from "./events";
import { restoreRunContextBudget } from "@/application/llm/contextBudget";
import type { RuntimeGraphSnapshot, RuntimeAgentSnapshot } from "./session";
import { inputGuardrails, checkHandoffInput, toolInputGuardrail } from "./policy";

type SdkAgent = Agent<unknown, AgentOutputType>;

/** Owns connections opened while the SDK changes agents within one invocation. */
export interface AgentGraph {
  imageSequence?: ImageSequence;
  history?: AgentInputItem[];
  persistent?: boolean;
  activeTurn?: RuntimeTurn;
  close: Array<() => Promise<void>>;
  identifiers?: RuntimeCallIds;
  scope?: string;
  saved?: RuntimeGraphSnapshot;
  capture?: Record<string, () => RuntimeAgentSnapshot>;
  handoffs?: RuntimeGraphSnapshot["handoffs"];
  ids?: Record<string, RuntimeCallIds>;
  delegations?: NonNullable<RuntimeGraphSnapshot["delegations"]>;
  restoreDelegations?: Map<string, (id: string, args: string) => Promise<void>>;
}

export function snapshotGraph(graph: AgentGraph): RuntimeGraphSnapshot {
  return {
    nextImageId: graph.imageSequence?.next,
    agents: Object.fromEntries(Object.entries(graph.capture ?? {}).map(([key, read]) => [key, read()])),
    handoffs: graph.handoffs ?? {},
    identifiers: Object.fromEntries(Object.entries(graph.ids ?? {}).map(([key, ids]) => [key, { prefix: ids.prefix, used: [...ids.used] }])),
    delegations: graph.delegations ?? [],
  };
}

/** Reconstruct deployment-bound agents before the SDK restores their saved identities. */
export async function restoreHandoffGraph(root: SdkAgent, graph: AgentGraph): Promise<void> {
  const agents = new Map<string, SdkAgent>([[root.name, root]]);
  for (const record of graph.saved?.handoffs[graph.scope ?? "root"] ?? []) {
    const source = agents.get(record.source);
    const transfer = source?.handoffs.find((entry) => entry instanceof Handoff && entry.toolName === record.tool);
    if (!(transfer instanceof Handoff)) throw new ValidationError("A saved handoff is no longer available");
    const target = await transfer.onInvokeHandoff(new RunContext({}), record.args);
    agents.set(target.name, target);
  }
  for (const record of graph.saved?.delegations?.filter((entry) => entry.scope === (graph.scope ?? "root")) ?? []) {
    const restore = graph.restoreDelegations?.get(`${record.scope}/${record.source}/${record.tool}`);
    if (!restore) throw new ValidationError("A saved delegated agent is no longer available");
    await restore(record.id, record.args);
  }
}

export function compileAgent(
  deps: AgentDeps, input: RunAgentInput, destination: RuntimeEmitter, graph: AgentGraph,
  inheritedFilter?: PiiFilter, transferredImages?: readonly ImageHandle[],
) {
  if (input.messages.some(hasImageParts)) {
    const refusal = describeImageInputReject(input.model);
    if (refusal) throw new ValidationError(refusal);
  }
  const output = createSdkOutput(destination);
  const emit = output.emit;
  if (input.parameters?.policy?.approvalTools?.some((name) => name.startsWith("handoff_"))) throw new ValidationError("Require approval for delegate tools, not handoffs");
  const scope = graph.scope ?? "root";
  const key = `${scope}/${input.agentName}`;
  const saved = graph.saved?.agents[key];
  const filter = inheritedFilter ?? (saved?.pii ? PiiFilter.restoreSnapshot(saved.pii) : input.parameters?.piiFiltering ? new PiiFilter() : undefined);
  const previousImages = scope === "root" && !saved ? input.runtime?.images ?? [] : [];
  graph.imageSequence ??= { next: graph.saved?.nextImageId ?? input.runtime?.nextImageId ?? 1 };
  const assembly = assembleAgentRun({ ...deps, canDelegate: Boolean(deps.loadAgent) }, {
    ...input, blockedTools: input.parameters?.policy?.blockedTools,
    images: saved?.images ?? transferredImages ?? previousImages, imageSequence: graph.imageSequence, retainInputImages: graph.persistent,
    messages: saved ? undefined : input.messages,
  });
  if (!graph.persistent && input.parameters?.policy?.approvalTools?.some((name) => assembly.tools.some((entry) => entry.function.name === name))) throw new ValidationError("This Agent's approval policy requires a persisted chat session");
  for (const warning of assembly.warnings) emit({ warning });
  const turn: RuntimeTurn = {
    conversation: graph.history ? [...conversationMessages(graph.history), ...(input.runtime?.checkpoint ? [] : input.messages)] : input.messages,
    number: saved?.turn ?? 0, maxTurns: input.maxTurn ?? 50, finalTurn: false, outputCut: false,
    model: saved?.activeModel ?? input.model, results: createToolResultBudget(saved?.resultChars ?? MAX_TOOL_RESULT_CHARS_PER_TURN),
    resources: saved?.resources,
    routing: saved?.routing,
    handoffTools: new Set(assembly.delegations.filter((entry) => entry.mode === "handoff").map((entry) => entry.name)),
  };
  if (saved?.context) {
    turn.contextBudget = restoreRunContextBudget(saved.context);
    turn.results = createToolResultBudget(saved.resultChars, turn.contextBudget);
  }
  graph.capture ??= {};
  graph.handoffs ??= {};
  graph.ids ??= {};
  graph.delegations ??= [];
  graph.restoreDelegations ??= new Map();
  graph.capture[key] = () => ({ activeModel: turn.model, pii: filter?.snapshot(), turn: turn.number, resultChars: turn.results.remaining(), context: turn.contextBudget?.snapshot(), images: assembly.images.list(), resources: turn.resources, routing: turn.routing });
  const savedIds = graph.saved?.identifiers[scope];
  graph.identifiers ??= { prefix: savedIds?.prefix, used: new Set(savedIds?.used ?? []) };
  graph.ids[scope] = graph.identifiers;
  const model = createRunModel(deps, input, turn, emit, filter, graph.identifiers);
  const outputType: AgentOutputType = input.parameters?.structuredOutput && input.parameters.jsonSchema
    ? { type: "json_schema", name: "response", strict: false, schema: input.parameters.jsonSchema as JsonSchemaDefinition["schema"] }
    : "text";
  const schemas = assembly.tools.length ? deps.createToolSchemaValidator?.() : undefined;
  if (assembly.tools.length && !schemas) throw new Error("Tool schema validation is not configured");
  const capabilities = createRuntimeTools(deps, input, assembly, turn, emit, filter, schemas);
  const agent: SdkAgent = new Agent<unknown, AgentOutputType>({
    name: input.agentName || "prompt", model, outputType,
    instructions: assembly.systemPrompt,
    tools: capabilities.tools,
    mcpServers: capabilities.mcp.servers,
    inputGuardrails: inputGuardrails(input.messages, input.parameters?.policy, filter),
  });
  const getMcpTools = agent.getMcpTools.bind(agent);
  agent.getMcpTools = async (...args) => (await getMcpTools(...args)).map(capabilities.mcp.bind);
  graph.activeTurn = turn;

  const validateTask = assembly.delegations.length ? schemas!.compile(AGENT_TASK_SCHEMA) : undefined;
  const task = (raw: string, signal = input.signal): AgentTask & { images: ImageHandle[] } => {
    const args: unknown = JSON.parse(raw);
    validateTask?.(args);
    if (!args || typeof args !== "object" || !("input" in args) || typeof args.input !== "string" || !args.input.trim()) throw new ValidationError("An agent task requires non-empty input");
    const ids = "image_ids" in args ? args.image_ids : [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new ValidationError("image_ids must be an array of image handles");
    const images = ids.map((id: string) => {
      const image = assembly.images.get(id);
      if (!image) throw new ValidationError(`Unknown image '${id}'. Available images: ${assembly.images.list().map((item) => item.id).join(", ")}`);
      return { ...image };
    });
    return { message: filter?.mask(args.input) ?? args.input, images, signal, maxTurns: Math.max(1, turn.maxTurns - turn.number) };
  };

  for (const binding of assembly.delegations) {
    if (input.parameters?.policy?.blockedTools?.includes(binding.name)) continue;
    const prototype = new BoundAgent(binding.agentName);
    if (binding.mode === "handoff") {
      let nextInput: RunAgentInput | undefined;
      const transfer = new Handoff<unknown, AgentOutputType>(prototype, async (context, args) => {
        const request = task(args);
        const prepared = await deps.loadAgent!(binding.agentName, { ...request, invocationId: `${input.agentName}/${binding.name}` });
        graph.close.push(prepared.close);
        for (const warning of prepared.warnings) emit({ warning });
        nextInput = prepared.input;
        const compiled = compileAgent(prepared.deps, prepared.input, emit, graph, filter, request.images);
        await checkHandoffInput(compiled.agent, prepared.input.messages, context);
        transfer.agent = compiled.agent;
        const records = graph.handoffs![scope] ??= [];
        if (!records.some((entry) => entry.source === input.agentName && entry.tool === binding.name && entry.args === args)) records.push({ source: input.agentName, tool: binding.name, args });
        return compiled.agent;
      });
      transfer.toolName = binding.name;
      transfer.toolDescription = assembly.tools.find((entry) => entry.function.name === binding.name)?.function.description ?? binding.agentName;
      transfer.inputJsonSchema = AGENT_TASK_SCHEMA;
      transfer.inputFilter = (data) => ({
        ...data,
        newItems: [...data.newItems, ...toAgentInput(nextInput?.messages ?? []).map((item) => new RunInputItem(item, transfer.agent))],
      });
      agent.handoffs.push(transfer);
      continue;
    }

    const metadata = { toolName: binding.name, toolDescription: assembly.tools.find((entry) => entry.function.name === binding.name)?.function.description ?? binding.agentName, parameters: AGENT_TASK_SCHEMA, inputGuardrails: [toolInputGuardrail(validateTask!, filter)], needsApproval: input.parameters?.policy?.approvalTools?.includes(binding.name) ?? false };
    // The SDK's source-agent metadata and nested RunState remain attached to this
    // actual Agent-as-Tool. Only resolving the local Agent's current settings is lazy.
    const runOptions = { maxTurns: turn.maxTurns, signal: input.signal };
    const delegate = prototype.asTool({
      ...metadata,
      inputBuilder: () => toAgentInput(prototype.current().input.messages),
      runConfig: studioRunConfig(deps.channel),
      runOptions,
      onStream: ({ event }) => prototype.current().observe?.(event),
      customOutputExtractor: (result) => {
        prototype.current().completed = true;
        prototype.current().paused = result.interruptions.length > 0;
        if (result.interruptions.length) return "";
        const text = typeof result.finalOutput === "string" ? result.finalOutput : JSON.stringify(result.finalOutput ?? "");
        return prototype.current().filter?.restore(text) ?? text;
      },
    });
    // Registry aliases are already valid and reserved. Preserve hyphens that
    // the SDK's convenience name normalizer would otherwise replace.
    delegate.name = binding.name;
    // Agent.asTool does not forward function-tool guardrails in this SDK version.
    delegate.inputGuardrails = metadata.inputGuardrails;
    const nativeInvoke = delegate.invoke.bind(delegate);
    const childOutput = (id: string): RuntimeEmitter => {
      const childEmit: RuntimeEmitter = (chunk) => emit({ ...chunk, author: chunk.author ?? binding.agentName, authorPath: [binding.agentName, ...(chunk.authorPath ?? [])], transferId: id });
      childEmit.ready = emit.ready;
      return childEmit;
    };
    const restoredChildren = new Map<string, { prepared: PreparedAgent; child: ReturnType<typeof compileAgent>; close: () => Promise<void> }>();
    graph.restoreDelegations.set(`${scope}/${input.agentName}/${binding.name}`, async (id, args) => {
      const childScope = `tool/${id}`;
      const request = task(args);
      const prepared = await deps.loadAgent!(binding.agentName, { ...request, invocationId: id });
      const restoredGraph: AgentGraph = { close: [], persistent: graph.persistent, imageSequence: graph.imageSequence, scope: childScope, saved: graph.saved, capture: graph.capture, handoffs: graph.handoffs, ids: graph.ids, delegations: graph.delegations, restoreDelegations: graph.restoreDelegations };
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await Promise.all([prepared.close(), ...restoredGraph.close.map((release) => release())]);
      };
      try {
        const child = compileAgent(prepared.deps, prepared.input, childOutput(id), restoredGraph, filter, request.images);
        await restoreHandoffGraph(child.agent, restoredGraph);
        prototype.bindDeclarations(child.agent);
        restoredChildren.set(id, { prepared, child, close });
        graph.close.push(close);
      } catch (error) { await close(); throw error; }
    });
    delegate.invoke = async (context, args, details) => {
      const id = details?.toolCall?.callId ?? randomUUID();
      const slot = claimToolSlot(turn, id);
      const restoredChild = restoredChildren.get(id);
      const childScope = `tool/${id}`;
      const childIds = graph.saved?.identifiers[childScope];
      const childGraph: AgentGraph = { close: [], persistent: graph.persistent, imageSequence: graph.imageSequence, scope: childScope, saved: graph.saved, capture: graph.capture, handoffs: graph.handoffs, ids: graph.ids, delegations: graph.delegations, restoreDelegations: graph.restoreDelegations,
        identifiers: { prefix: childIds?.prefix ?? randomUUID().replaceAll("-", ""), used: new Set(childIds?.used ?? []) } };
      const childEmit = childOutput(id);
      let paused = false;
      let text = "";
      try {
        const request = task(args, details?.signal ?? input.signal);
        request.invocationId = id;
        const transcript = buildTransferTranscript(turn.conversation ?? input.messages, input.agentName);
        if (transcript.dropped) emit({ warning: "Earlier conversation was omitted from the delegated task's bounded context." });
        request.transcript = filter?.mask(transcript.text) ?? transcript.text;
        const prepared = restoredChild?.prepared ?? await deps.loadAgent!(binding.agentName, request);
        if (!graph.delegations!.some((entry) => entry.scope === scope && entry.id === id)) graph.delegations!.push({ scope, source: input.agentName, tool: binding.name, id, args });
        if (!restoredChild) childGraph.close.push(prepared.close);
        for (const warning of prepared.warnings) childEmit({ warning });
        const child = restoredChild?.child ?? compileAgent(prepared.deps, prepared.input, childEmit, childGraph, filter, request.images);
        if (details?.resumeState && !restoredChild) await restoreHandoffGraph(child.agent, childGraph);
        runOptions.maxTurns = child.turn.maxTurns;
        text = await prototype.withInvocation(child.agent, prepared.input, async () => {
          const result = String(await nativeInvoke(context, args, details));
          if (!prototype.current().completed) throw new ValidationError(result);
          paused = prototype.current().paused;
          if (!paused && child.turn.finalTurn) childEmit({ warning: `Agent '${binding.agentName}' reached its turn limit (${child.turn.maxTurns} turns); the parent continues with its partial result.` });
          return result;
        }, child.observe, child.filter);
      } catch (error) {
        (details?.signal ?? input.signal)?.throwIfAborted();
        text = `Error: Agent '${binding.agentName}' failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        await restoredChild?.close();
        await Promise.all(childGraph.close.map((close) => close()));
        if (!paused) childEmit({ authorDone: true });
      }
      if (paused) { slot?.complete(); return ""; }
      if (text.startsWith("Error:")) {
        getCurrentSpan()?.setError({ message: "Delegated agent failed" });
        emit({ warning: `Agent '${binding.agentName}': ${text}` });
      }
      if (slot) await waitForSlot(slot.previous, details?.signal ?? input.signal);
      const result = writeToolResult({ id, name: `${binding.name}: ${binding.agentName}`, text }, turn.results, emit, filter);
      if (result.truncated) emit({ warning: "Tool output was truncated to fit the run's context budget." });
      slot?.complete();
      return result.text;
    };
    agent.tools.push(delegate);
  }
  return { agent, turn, filter, observe: output.observe };
}
