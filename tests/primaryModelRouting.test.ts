import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { withTrace, NoopTrace, type ModelRequest } from "@openai/agents";
import { createRunModel } from "@/application/runtime/model";
import { createToolResultBudget, MAX_TOOL_RESULT_CHARS_PER_TURN } from "@/application/llm/toolResultBudget";
import { listModels, replaceModelRegistry, type ModelConfig } from "@/domain/llm/models";
import { DEFAULT_CALL_ROUTING_POLICY, MODEL_ROUTING_POLICY_BINDING } from "@/domain/llm/callRouting";
import { primaryRoutingTask, primaryCallPurpose } from "@/application/runtime/modelRouting";
import { runAgent } from "@/application/runtime";
import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import type { AgentDeps, RunAgentInput } from "@/application/runtime/types";
import { FakeChannel, contentChunk, toolCallChunk, usageChunk } from "./fakeChannel";
import type { TraceSpan } from "@/domain/trace/types";

import { runtimeSessionFixture } from "./runtimeSessionFixture";
import { openRuntimeSession, pendingRuntimeApproval, readRuntimeSession, modelRoutingPolicyFingerprint, runtimeFingerprint } from "@/application/runtime/session";

const original = listModels();
const capabilities = { tools: true, reasoning: true, structuredOutput: true, imageInput: true };
function model(id: string, patch: Partial<ModelConfig> = {}): ModelConfig {
  return { id, displayName: id, family: "test", maker: "test", provider: "local", providerKind: "selfhosted",
    contextWindow: 32_000, maxTokens: 8_192, pricing: { inputPer1M: 0.1, outputPer1M: 0.5 }, capabilities, ...patch };
}
const input: RunAgentInput = { agentName: "test", model: "local/base", parameters: { modelRouting: true }, messages: [{role:"user",content:"이 메모를 한 문장으로 요약해 주세요."}] };
function setup(channel: AgentDeps["channel"]) {
  const spans: TraceSpan[] = [];
  const choose = vi.fn<NonNullable<AgentDeps["callRouting"]>["decision"]["choose"]>().mockResolvedValue({choice:"fast",confidence:0.8,probabilities:{fast:0.9,general:0.1}});
  const deps: AgentDeps = { channel, createToolSchemaValidator, onSdkSpan:span=>spans.push(span),
    modelRoutingPolicy: {...DEFAULT_CALL_ROUTING_POLICY,tiers:{fast:"local/fast",general:"local/base"}},
    callRouting: {decision:{choose},selectedDecisionModel:async()=>"local/jev",canUseModel:async()=>true} };
  return { deps, choose, spans };
}
async function collect(deps: AgentDeps, request=input) {
  const chunks=[];
  for await(const chunk of runAgent(deps,request)) chunks.push(chunk);
  return chunks;
}
beforeEach(()=> {
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
  replaceModelRegistry([model("local/base"),model("local/fast"),model("local/jev",{pricing:{inputPer1M:0.042,outputPer1M:0},capabilities:{...capabilities,decision:true}})]);
});
afterEach(()=>{vi.useRealTimers();replaceModelRegistry(original);});

describe("automatic primary model routing",()=>{
  it("selects before the first streamed response without a planner or ModelTask, and exposes actual usage",async()=>{
    const channel=new FakeChannel([[contentChunk("요약입니다."),usageChunk(10,3,undefined,0.00001)]]);
    const {deps,choose,spans}=setup(channel);const chunks=await collect(deps);
    expect(channel.seenParams.map(request=>request.model)).toEqual(["local/fast"]);
    expect(channel.seenParams[0]?.reasoningEffort).toBe("low");
    expect(chunks.map(chunk=>chunk.delta?.content??"").join("")).toBe("요약입니다.");
    expect(chunks.find(chunk=>chunk.usage)?.usage).toMatchObject({model:"local/fast",costUsd:0.00001});
    expect(choose).toHaveBeenCalledTimes(1);
    expect(spans.filter(span=>span.kind==="model").map(span=>span.name)).toEqual(["local/jev","local/fast"]);
    expect(spans.find(span=>span.name==="model-routing")?.output?.routing).toContainEqual(expect.objectContaining({callKind:"primary",model:"local/fast",outcome:"selected"}));
  });
  it("also routes native non-streaming calls and attributes billing to the selected model",async()=>{
    const channel=new FakeChannel([[contentChunk("요약"),usageChunk(10,3,undefined,0.00001)]]);
    const {deps}=setup(channel);deps.recordUsage=vi.fn();
    const model=createRunModel(deps,input,{number:0,maxTurns:4,finalTurn:false,outputCut:false,model:input.model,results:createToolResultBudget(MAX_TOOL_RESULT_CHARS_PER_TURN)},()=>{});
    await withTrace(new NoopTrace(),()=>model.getResponse({input:"한 문장으로 요약해 주세요.",tools:[],handoffs:[],outputType:"text",modelSettings:{},tracing:false}));
    expect(channel.seenParams.map(request=>request.model)).toEqual(["local/fast"]);
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({model:"local/fast",costUsd:0.00001}));
  });
  it("rejects a smaller context candidate against full replay before spending on a decision",async()=>{
    replaceModelRegistry([model("local/base"),model("local/fast",{contextWindow:4_000,maxTokens:1_000})]);
    const channel=new FakeChannel([[contentChunk("답변")]]);const {deps,choose}=setup(channel);
    await collect(deps,{...input,messages:[{role:"user",content:"a".repeat(9_000)}]});
    expect(channel.seenParams[0]?.model).toBe("local/base");expect(choose).not.toHaveBeenCalled();
  });
  it.each([false,undefined])("uses the configured model without a paid decision when routing=%s",async(modelRouting)=>{
    const channel=new FakeChannel([[contentChunk("답변")]]);const {deps,choose}=setup(channel);
    await collect(deps,{...input,parameters:{modelRouting}});
    expect(channel.seenParams[0]?.model).toBe("local/base");expect(choose).not.toHaveBeenCalled();
  });
  it("filters tool-ineligible cheap models before selection and keeps operator reasoning effort",async()=>{
    replaceModelRegistry([model("local/base"),model("local/fast",{capabilities:{...capabilities,tools:false}})]);
    const channel=new FakeChannel([[contentChunk("답변")]]);const {deps,choose}=setup(channel);
    await collect(deps,{...input,parameters:{modelRouting:true,reasoningEffort:"high",maxTokens:100}});
    expect(channel.seenParams[0]).toMatchObject({model:"local/base",reasoningEffort:"high",maxTokens:100});
    expect(choose).not.toHaveBeenCalled();
  });
  it("can choose a vision model when the configured fallback has no image input",async()=>{
    replaceModelRegistry([model("local/base",{capabilities:{...capabilities,imageInput:false}}),model("local/fast")]);
    const channel=new FakeChannel([[contentChunk("원 하나입니다.")]]);const {deps}=setup(channel);
    const chunks=await collect(deps,{...input,messages:[{role:"user",content:[{type:"text",text:"그림의 도형 수를 세어 주세요."},{type:"image_url",image_url:{url:"data:image/png;base64,aW1hZ2U="}}]}]});
    expect(chunks.some(chunk=>chunk.error)).toBe(false);expect(channel.seenParams[0]?.model).toBe("local/fast");
  });
  it("keeps medium reasoning for general responses on the general tier",async()=>{
    const channel=new FakeChannel([[contentChunk("설명")]]);const {deps,choose}=setup(channel);
    choose.mockResolvedValue({choice:"general",confidence:1,probabilities:{general:1,fast:0}});
    await collect(deps,{...input,messages:[{role:"user",content:"이 아키텍처의 장단점을 설명해 주세요."}]});
    expect(channel.seenParams[0]).toMatchObject({model:"local/base",reasoningEffort:"medium"});
  });
  it("admits an operator-configured transport fallback even outside the automatic tier pool",async()=>{
    replaceModelRegistry([...listModels(),model("local/fallback")]);
    const fallback=new FakeChannel([[contentChunk("fallback answer")]]);let failedCalls=0;
    const channel:AgentDeps["channel"]={getModel:async(name)=>name==="local/fast"?{
      getResponse:async()=>{throw new Error("unused");},async *getStreamedResponse(){failedCalls++;throw Object.assign(new Error("unavailable"),{status:503});},
    }:fallback.getModel(name)};
    const {deps}=setup(channel);const chunks=await collect(deps,{...input,fallbackModel:"local/fallback"});
    expect(failedCalls).toBe(1);expect(fallback.seenParams[0]?.model).toBe("local/fallback");expect(chunks.some(chunk=>chunk.error)).toBe(false);
  });
  it("caps an implicit output to the available budget and refuses an unaffordable explicit cap before generation",async()=>{
    replaceModelRegistry([model("local/base",{pricing:{inputPer1M:0,outputPer1M:100}})]);
    const channel=new FakeChannel([[contentChunk("答")]]);const {deps}=setup(channel);
    deps.modelRoutingPolicy={...DEFAULT_CALL_ROUTING_POLICY,tiers:{general:"local/base"},maxCallCostUsd:0.01};
    await collect(deps);
    expect(channel.seenParams[0]?.maxTokens).toBe(100);
    const denied=new FakeChannel([]);const chunks=await collect({...deps,channel:denied},{...input,parameters:{modelRouting:true,maxTokens:101}});
    expect(denied.calls).toBe(0);expect(chunks.some(chunk=>chunk.error?.includes("budget"))).toBe(true);
  });
  it("retains the selected model after a tool result without another paid decision",async()=>{
    const channel=new FakeChannel([[toolCallChunk(0,"read","read","{}")],[contentChunk("완료")]]);const {deps,choose}=setup(channel);
    deps.callMcpTool=async()=>({text:"자료"});
    await collect(deps,{...input,mcpTools:[{type:"function",function:{name:"read",parameters:{type:"object",properties:{}}}}]});
    expect(channel.seenParams.map(request=>request.model)).toEqual(["local/fast","local/fast"]);expect(choose).toHaveBeenCalledTimes(1);
  });
  it("allows the configured fallback as an independent model when the actual primary is different",async()=>{
    const args=JSON.stringify({purpose:"reasoning",prompt:"Independently verify",require_different_model:true,model:null,image_ids:[]});
    const channel=new FakeChannel([[toolCallChunk(0,"verify","ModelTask",args)],[contentChunk("검증됨")],[contentChunk("완료")]]);
    const {deps}=setup(channel);
    deps.modelRoutingPolicy={...deps.modelRoutingPolicy!,policies:{summary:"fast",reasoning:"general"}};
    const chunks=await collect(deps);
    expect(chunks.some(chunk=>chunk.error)).toBe(false);
    expect(channel.seenParams.map(request=>request.model)).toEqual(["local/fast","local/base","local/fast"]);
  });
  it("never retries a partly emitted routed response",async()=>{
    const channel=new FakeChannel([]);const {deps}=setup(channel);let calls=0;
    deps.channel={getModel:async()=>({getResponse:async()=>{throw new Error("unused");},async *getStreamedResponse(){calls++;yield {type:"output_text_delta" as const,delta:"partial"};throw Object.assign(new Error("stream failed"),{status:503});}})};
    const chunks=await collect(deps,{...input,fallbackModel:"local/base"});
    expect(calls).toBe(1);expect(chunks.map(chunk=>chunk.delta?.content??"").join("")).toBe("partial");
    expect(chunks.some(chunk=>chunk.error?.includes("stream failed"))).toBe(true);
  });
  it.each(["handoff_child","delegate_child"])("shares the parent's inference limit with %s",async(toolName)=>{
    const channel=new FakeChannel([[toolCallChunk(0,"child-call",toolName,JSON.stringify({input:"summarize",image_ids:[]}))],[contentChunk("child answer")]]);
    const {deps}=setup(channel);deps.canDelegate=true;
    deps.modelRoutingPolicy={...deps.modelRoutingPolicy!,maxCalls:1};
    deps.loadAgent=async(name,task)=>({deps,input:{...input,agentName:name,messages:[{role:"user",content:task.message}],signal:task.signal},warnings:[],close:async()=>{}});
    const chunks=await collect(deps,{...input,canDispatch:true,subagents:[{name:"child",description:"Specialist"}]});
    expect(channel.calls).toBe(1);expect(chunks,JSON.stringify(chunks)).toEqual(expect.arrayContaining([expect.objectContaining({error:expect.stringContaining("call limit")})]));
  });
  it("refuses an older accounting contract before claiming a pending approval",async()=>{
    const f=runtimeSessionFixture({approvalTools:["Skill"]});
    f.configuration.model="local/base";f.configuration.parameters.modelRouting=true;
    const channel=new FakeChannel([[toolCallChunk(0,"approve","Skill",'{"skill_name":"guide"}')]]);
    const {deps}=setup(channel);deps.loadSkillContent=async()=>"Instructions";
    const runtime=await openRuntimeSession(f.services,f.scope);
    runtime.checkBinding(MODEL_ROUTING_POLICY_BINDING,runtimeFingerprint(deps.modelRoutingPolicy));
    await collect(deps,{...input,agentName:"agent",model:f.configuration.model,parameters:f.configuration.parameters,runtime,skills:[{name:"guide",description:"Guidance"}]});
    const pending=(await pendingRuntimeApproval(f.services,"chat-1",f.scope.ownerEmail))!;
    expect(pending).not.toBeNull();
    const revision=f.rows.get("chat-1")!.revision;
    await expect(openRuntimeSession(f.services,{...f.scope,routingPolicyFingerprint:modelRoutingPolicyFingerprint(deps.modelRoutingPolicy!)},
      {revision:pending.revision,decisions:[{id:pending.approvals[0]!.id,approve:true}]})).rejects.toThrow("routing policy changed");
    expect(f.rows.get("chat-1")!.revision).toBe(revision);
    const saved=await readRuntimeSession(f.services,"chat-1",f.scope.ownerEmail);
    expect(saved?.document.checkpoint?.status).toBe("pending");
    expect(saved?.document.checkpoint?.graph.routing?.calls).toBe(1);
  });
  it("uses full system, tools, replay and image context for admission without counting image bytes as text",()=>{
    const request:ModelRequest={input:[{role:"user",content:[{type:"input_text",text:"도형"},{type:"input_image",image:"data:image/png;base64,"+"A".repeat(100_000),detail:"auto"}]}],systemInstructions:"system ".repeat(1_000),tools:[],handoffs:[],outputType:"text",modelSettings:{},tracing:false};
    const task=primaryRoutingTask(request,input);
    expect(task.purpose).toBe("vision");expect(task.imageCount).toBe(1);expect(task.inputTokens).toBeGreaterThan(4_000);expect(task.inputTokens).toBeLessThan(6_000);
    const followUp=primaryRoutingTask({...request,input:[...(Array.isArray(request.input)?request.input:[]),{role:"user",content:"JavaScript 함수를 작성하세요"}]},input);
    expect(followUp.purpose).toBe("coding");expect(followUp.imageCount).toBe(1);
    expect(primaryCallPurpose("JavaScript 함수를 작성하세요",0)).toBe("coding");
    expect(primaryCallPurpose("작업자 2명의 최소 완료 시간을 증명하세요",0)).toBe("reasoning");
  });
});
