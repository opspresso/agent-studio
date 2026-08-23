/**
 * `runLocalSubagent` collects the child's own answer text from its stream. A
 * grandchild's chunks travel out on that same stream, authored — so absorbing
 * every delta credited the child with the grandchild's words, twice over: once
 * inside the child's answer, once in the tool result the nested transfer had
 * already returned.
 */

import { describe, expect, it } from "vitest";
import { runLocalSubagent } from "@/application/execution/subagentRunner";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { RunOrigin } from "@/domain/execution/actor";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";

function project(name: string): Project {
  return {
    name,
    displayName: name,
    description: "",
    projectType: "agent",
    ownerEmail: "owner@example.com",
    publishedVersion: "v1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function version(projectName: string, overrides: Partial<Version> = {}): Version {
  return {
    projectName,
    versionName: "v1",
    systemPrompt: "s",
    userPromptTemplate: "",
    model: "google/gemini-2.5-flash",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

async function collect(source: AsyncGenerator<EngineChunk, string>) {
  const chunks: EngineChunk[] = [];
  let step = await source.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await source.next();
  }
  return { chunks, text: step.value };
}

describe("runLocalSubagent with a nested transfer", () => {
  it("keeps the grandchild's words out of the child's answer", async () => {
    const channel = new FakeChannel([
      // The child's first turn: transfer to the grandchild.
      [
        toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"grand","message":"go"}'),
        usageChunk(1, 1),
      ],
      // The grandchild's whole run.
      [contentChunk("grand-words"), usageChunk(1, 1)],
      // The child answers after the transfer returns.
      [contentChunk("child-answer"), usageChunk(1, 1)],
    ]);
    const projects = new Map([
      ["child", project("child")],
      ["grand", project("grand")],
    ]);
    const versions = new Map([
      ["child", version("child", { subagentList: [{ name: "grand", type: "local" }] })],
      ["grand", version("grand")],
    ]);
    const deps = {
      channel,
      projects: { get: async (name: string) => projects.get(name) ?? null },
      versions: { get: async (name: string) => versions.get(name) ?? null },
      skills: { get: async () => null, list: async () => [] },
      externalAgents: { get: async () => null },
    } as unknown as ExecutionDeps;
    const origin = {
      actor: { kind: "user", id: "u@example.com" },
      ancestry: ["parent", "child"],
    } as unknown as RunOrigin;

    const { chunks, text } = await collect(
      runLocalSubagent(deps, "child", "hi", 1, 8, async () => {}, origin),
    );

    // The grandchild still streams — its words reach the reader, authored.
    expect(
      chunks.some((c) => c.author === "grand" && c.delta?.content === "grand-words"),
    ).toBe(true);
    // But the child's answer is the child's alone.
    expect(text).toBe("child-answer");
  });
});

/**
 * The ceiling a child runs under.
 *
 * A child continues the parent's turn counter, so its own `maxTurn` is how many
 * turns it gets rather than a point on that counter. Read as a point, a
 * specialised agent transferred to late never called its model at all: it
 * tripped `turn >= maxTurn` on entry and answered `""`, which the parent
 * reported as "returned no answer".
 */
describe("runLocalSubagent and the child's own maxTurn", () => {
  const child = (overrides: Partial<Version>) => {
    const channel = new FakeChannel([[contentChunk("answered"), usageChunk(1, 1)]]);
    const projects = new Map([["child", project("child")]]);
    const versions = new Map([["child", version("child", overrides)]]);
    const deps = {
      channel,
      projects: { get: async (name: string) => projects.get(name) ?? null },
      versions: { get: async (name: string) => versions.get(name) ?? null },
      skills: { get: async () => null, list: async () => [] },
      externalAgents: { get: async () => null },
    } as unknown as ExecutionDeps;
    const origin = {
      actor: { kind: "user", id: "u@example.com" },
      ancestry: ["parent", "child"],
    } as unknown as RunOrigin;
    // Entered on turn 13 of a run whose own ceiling is 50 — past a child
    // configured with 10, if that 10 were a point on the shared counter.
    return collect(runLocalSubagent(deps, "child", "hi", 13, 50, async () => {}, origin));
  };

  it("gives a child transferred to late the turns its version asks for", async () => {
    expect((await child({ maxTurn: 10 })).text).toBe("answered");
  });

  it("treats a maxTurn stored as null the way an absent one is treated", async () => {
    // `versionRepository.fromItem` casts `item.maxTurn` blind out of JSONB, so
    // a stored null arrives typed `undefined` and is not — and `turn + null` is
    // `turn`, which trips the child on entry.
    expect((await child({ maxTurn: null as unknown as number })).text).toBe("answered");
    expect((await child({})).text).toBe("answered");
  });
});
