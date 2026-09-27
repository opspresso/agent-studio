import {describe,expect,it} from "vitest";
import type {ModelResponse} from "@openai/agents";
import {modelResponseHasOutput,modelResponseIsTruncated} from "@/application/runtime/modelUsage";

function response(output: ModelResponse["output"], outputTokens=2048) { return {output,usage:{outputTokens}}; }
const text: ModelResponse["output"] = [{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"answer"}]}];
const reasoning: ModelResponse["output"] = [{type:"reasoning",content:[]}];
describe("native response output limits",()=>{
  it("does not infer truncation for a complete answer at the token cap",()=>{
    expect(modelResponseHasOutput(response(text))).toBe(true);
    expect(modelResponseIsTruncated(response(text),2048)).toBe(false);
  });
  it("recognizes an explicit length finish even with an answer and no configured cap",()=>{
    expect(modelResponseIsTruncated({...response(text),providerData:{choices:[{finish_reason:"length"}]}})).toBe(true);
  });
  it("does not treat tool calls or refusals as reasoning-only output",()=>{
    const tool:ModelResponse["output"]=[{type:"function_call",callId:"call",name:"lookup",arguments:"{}"}];
    const refusal:ModelResponse["output"]=[{type:"message",role:"assistant",status:"completed",content:[{type:"refusal",refusal:"Cannot help"}]}];
    for(const output of [tool,refusal]) expect(modelResponseIsTruncated(response(output),2048)).toBe(false);
  });
  it("infers exhaustion only with a known reached cap and no usable output",()=>{
    expect(modelResponseIsTruncated(response(reasoning),2048)).toBe(true);
    expect(modelResponseIsTruncated(response([]),2048)).toBe(true);
    expect(modelResponseIsTruncated(response(reasoning,100),2048)).toBe(false);
    expect(modelResponseIsTruncated(response(reasoning))).toBe(false);
  });
});
