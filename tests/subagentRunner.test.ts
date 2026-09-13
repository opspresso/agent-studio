/**
 * `runLocalSubagent` collects the child's own answer text from its stream. A
 * grandchild's chunks travel out on that same stream, authored — so absorbing
 * every delta credited the child with the grandchild's words, twice over: once
 * inside the child's answer, once in the tool result the nested transfer had
 * already returned.
 */

import { describe, expect, it } from "vitest";
import { runImageSubagent } from "@/application/execution/imageTool";
import type { RunOrigin } from "@/domain/execution/actor";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { Project, Version } from "@/domain/project/types";
import type { Trace } from "@/domain/trace/types";

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





/**
 * The ceiling a child runs under.
 *
 * A child continues the parent's turn counter, so its own `maxTurn` is how many
 * turns it gets rather than a point on that counter. Read as a point, a
 * specialised agent transferred to late never called its model at all: it
 * tripped `turn >= maxTurn` on entry and answered `""`, which the parent
 * reported as "returned no answer".
 */


describe("subagent cancellation traces", () => {
  const origin = { ancestry: ["parent", "child"] } as RunOrigin;



  it("records a caller-aborted image child as cancelled", async () => {
    const controller = new AbortController();
    const responseAborted = new Error("ResponseAborted");
    const traces: Trace[] = [];
    const imageChannel: ImageChannel = {
      async generateImage() {
        controller.abort(responseAborted);
        throw responseAborted;
      },
      async editImage() {
        throw new Error("not used");
      },
    };
    const imageProject = { ...project("child"), projectType: "image" as const };
    const imageVersion = version("child", { model: "openai/gpt-image-2" });
    const stream = runImageSubagent(
      {
        imageChannel,
        traces: { put: async (trace: Trace) => void traces.push(trace) } as never,
      },
      "child",
      imageProject,
      imageVersion,
      "draw",
      async () => {},
      origin,
      controller.signal,
    );

    await expect(stream.next()).rejects.toBe(responseAborted);
    expect(traces[0]?.status).toBe("cancelled");
    expect(traces[0]?.error).toBeUndefined();
  });
});
