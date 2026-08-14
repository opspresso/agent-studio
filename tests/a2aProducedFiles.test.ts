/**
 * A file a run produced, on the A2A surface.
 *
 * Its own file because the run has to be stubbed: a document arrives from an
 * MCP tool result, and standing one up through the real engine would test the
 * engine rather than what this executor does with the chunk. What it does was
 * nothing at all — `chunkParts` answered images and text and dropped
 * `chunk.file`, so a task asked for a report completed with the prose and
 * without the report.
 */

import { describe, expect, it, vi } from "vitest";
import type { Task } from "@a2a-js/sdk";
import type { AgentExecutionEvent, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { ExecutionDeps } from "@/application/execution/runProject";

const { chunks } = vi.hoisted(() => ({ chunks: [] as EngineChunk[] }));

vi.mock("@/application/execution/runProject", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/application/execution/runProject")>()),
  executeProjectStream: async function* (): AsyncGenerator<EngineChunk> {
    for (const chunk of chunks) {
      yield chunk;
    }
  },
}));

const { ProjectA2aExecutor } = await import("@/application/a2a/executor");
const { RequestContext } = await import("@a2a-js/sdk/server");

const project: Project = {
  name: "reporter",
  displayName: "Reporter",
  description: "",
  projectType: "agent",
  ownerEmail: "owner@x.com",
  publishedVersion: "1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const version: Version = {
  projectName: "reporter",
  versionName: "1",
  systemPrompt: "",
  userPromptTemplate: "",
  model: "openai/gpt-5-mini",
  parameters: { piiFiltering: false },
  mcpList: [],
  skillList: [],
  subagentList: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const rendered: EngineChunk = {
  file: {
    name: "report.docx",
    mimeType: "application/msword",
    source: "mcp: render_document",
    byteSize: 2048,
    key: "objects/report.docx",
  },
};

class CollectingBus implements ExecutionEventBus {
  events: AgentExecutionEvent[] = [];
  publish(event: AgentExecutionEvent): void {
    this.events.push(event);
  }
  on(): this {
    return this;
  }
  off(): this {
    return this;
  }
  once(): this {
    return this;
  }
  removeAllListeners(): this {
    return this;
  }
  finished(): void {}
}

/** Only `artifacts` is reached: the run itself is stubbed above. */
function depsWith(artifacts: unknown): ExecutionDeps {
  return { artifacts } as unknown as ExecutionDeps;
}

function userMessage(text: string) {
  return {
    kind: "message" as const,
    messageId: "m1",
    role: "user" as const,
    parts: [{ kind: "text" as const, text }],
  };
}

const store = { load: async (): Promise<Task | undefined> => undefined, save: async () => {} };

async function run(deps: ExecutionDeps): Promise<CollectingBus> {
  const executor = new ProjectA2aExecutor(deps, project, version, store);
  const bus = new CollectingBus();
  await executor.execute(new RequestContext(userMessage("write the report"), "t1", "c1"), bus);
  return bus;
}

describe("a file a run produced, on the A2A surface", () => {
  it("publishes it as a file part addressed by uri", async () => {
    chunks.length = 0;
    chunks.push({ delta: { content: "Here is your report." } }, rendered, { done: true });
    const bus = await run(
      depsWith({ objects: { sign: async (key: string) => `https://signed/${key}` } }),
    );

    const parts = bus.events
      .filter((event) => event.kind === "artifact-update")
      .flatMap((event) => ("artifact" in event ? event.artifact.parts : []));
    // `bytes` is not an option — the bracket stored the document and dropped the
    // payload long before this saw it.
    expect(parts).toContainEqual({
      kind: "file",
      file: {
        uri: "https://signed/objects/report.docx",
        mimeType: "application/msword",
        name: "report.docx",
      },
    });
    const last = bus.events.at(-1);
    expect(last && "status" in last ? last.status.state : undefined).toBe("completed");
  });

  it("completes with the reason instead when there is no address to give", async () => {
    chunks.length = 0;
    chunks.push(rendered, { done: true });
    const bus = await run(depsWith(undefined));

    const parts = bus.events
      .filter((event) => event.kind === "artifact-update")
      .flatMap((event) => ("artifact" in event ? event.artifact.parts : []));
    expect(parts).toEqual([]);
    // The task still completed — the run did what it was asked — but a caller
    // reading a bare artifact must be able to tell this from a run that had
    // nothing to produce.
    const last = bus.events.at(-1);
    const message =
      last && "status" in last && last.status.message
        ? last.status.message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("")
        : "";
    expect(message).toContain("were not kept");
  });
});
