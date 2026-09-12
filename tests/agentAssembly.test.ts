/**
 * One assembly, two readers.
 *
 * The builders always had a single owner; the *arguments* did not. `runAgent`
 * and the Playground preview each spelled out their own positional argument
 * list, and they had already drifted — the preview omitted the last one, so a
 * version that opted into `callerContext` previewed a prompt without the caller
 * block every real run carries. These tests pin the two together at the seam
 * that drifted, and pin the gate that was asymmetric.
 */

import { describe, expect, it } from "vitest";
import { assembleAgentRun, type AgentDeps, type SubagentInfo } from "@/application/runtime";
import type { RunCaller } from "@/domain/execution/actor";

const CALLER: RunCaller = { displayName: "Bruce", timezone: "Asia/Seoul" };
const SKILLS = [{ name: "greeting", description: "How to greet" }];
const SUBAGENTS: SubagentInfo[] = [{ name: "child", description: "A child", type: "local" }];

/** A dep bag that can do everything, so a capability's absence is never the reason. */
function fullDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    channel: {} as AgentDeps["channel"],
    loadSkillContent: async () => "body",
    canDelegate: true,
    generateImage: async () => ({ b64: "", mimeType: "image/png", model: "openai/gpt-image-1" }),
    editImage: async () => ({ b64: "", mimeType: "image/png", model: "openai/gpt-image-1" }),
    ...overrides,
  };
}

const names = (deps: AgentDeps, input: Parameters<typeof assembleAgentRun>[1] = {}) =>
  assembleAgentRun(deps, input).tools.map((tool) => tool.function.name);

describe("the caller block", () => {
  it("appears whenever a caller is assembled in, for a run and a preview alike", () => {
    const withCaller = assembleAgentRun(fullDeps(), { caller: CALLER });
    const without = assembleAgentRun(fullDeps(), {});
    expect(withCaller.systemPrompt).toContain("You are answering Bruce.");
    expect(without.systemPrompt).not.toContain("Bruce");
  });

  it("is the only difference a caller makes to the tool set", () => {
    // The preview's whole job is to show the prompt a run would send; a caller
    // must not change what the model can *do*, or the two would answer
    // differently for a reason the preview never showed.
    expect(names(fullDeps(), { caller: CALLER, skills: SKILLS })).toEqual(
      names(fullDeps(), { skills: SKILLS }),
    );
  });
});

describe("a builtin is offered only when the run can perform it", () => {
  it("offers the Skill tool with a loader", () => {
    const assembly = assembleAgentRun(fullDeps(), { skills: SKILLS });
    expect(assembly.tools.map((tool) => tool.function.name)).toContain("Skill");
    expect(assembly.builtinNames.has("Skill")).toBe(true);
    expect(assembly.systemPrompt).toContain("## Available Skills");
    expect(assembly.systemPrompt).toContain("greeting");
    expect(assembly.systemPrompt).toContain("How to greet");
  });

  it("withholds it without one, rather than answering every call with an error", () => {
    // The asymmetry this closes: the four other builtins were gated on their own
    // dependency and this one was gated on the skill list alone, so a run could
    // advertise it and then answer "cannot be executed in this context".
    const deps = fullDeps();
    delete deps.loadSkillContent;
    const assembly = assembleAgentRun(deps, { skills: SKILLS });
    expect(assembly.tools.map((tool) => tool.function.name)).not.toContain("Skill");
    expect(assembly.builtinNames.has("Skill")).toBe(false);
    expect(assembly.systemPrompt).not.toContain("## Available Skills");
    expect(assembly.systemPrompt).not.toContain("greeting");
  });

  it("withholds the image tools without their channels", () => {
    const deps = fullDeps();
    delete deps.generateImage;
    delete deps.editImage;
    const tools = names(deps, { subagents: SUBAGENTS });
    expect(tools).not.toContain("GenerateImage");
    expect(tools).not.toContain("EditImage");
  });

  it("withholds transfer and dispatch without a runner", () => {
    // Same shape as the Skill gate, and it had the same fault: the transfer tool
    // was offered on the subagent list alone, so a run with no runner
    // advertised delegation and answered a call with "requires agent_name and
    // message" — about the arguments, when the reason was that nothing could
    // carry them.
    const deps = fullDeps();
    delete deps.canDelegate;
    const assembly = assembleAgentRun(deps, { subagents: SUBAGENTS, canDispatch: true });
    const offered = assembly.tools.map((tool) => tool.function.name);
    expect(offered).not.toContain("handoff_child");
    expect(offered).not.toContain("delegate_child");
    // And the prompt does not describe what the tools cannot do.
    expect(assembly.systemPrompt).not.toContain("child");
  });

  it("withholds dispatch from a run the facade did not admit as top-level", () => {
    expect(names(fullDeps(), { subagents: SUBAGENTS })).not.toContain("delegate_child");
    expect(names(fullDeps(), { subagents: SUBAGENTS, canDispatch: true })).toContain(
      "delegate_child",
    );
  });
});

describe("what the assembly reports back", () => {
  it("registers no image handles for a run that can do nothing with one", () => {
    const deps = fullDeps();
    delete deps.editImage;
    const assembly = assembleAgentRun(deps, {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
          ],
        },
      ],
    });
    expect(assembly.canEdit).toBe(false);
    expect(assembly.images.list()).toEqual([]);
  });

  it("registers them when the run can edit", () => {
    const assembly = assembleAgentRun(fullDeps(), {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
          ],
        },
      ],
    });
    expect(assembly.canEdit).toBe(true);
    expect(assembly.images.list()).toHaveLength(1);
  });

  it("names exactly the builtins it offered", () => {
    const assembly = assembleAgentRun(fullDeps(), {
      skills: SKILLS,
      subagents: SUBAGENTS,
      canDispatch: true,
    });
    expect([...assembly.builtinNames].sort()).toEqual(
      ["EditImage", "GenerateImage", "Skill", "delegate_child", "handoff_child"].sort(),
    );
  });
});
