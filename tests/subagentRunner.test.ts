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
