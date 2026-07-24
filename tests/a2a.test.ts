import { describe, expect, it, vi } from "vitest";

// Card builders resolve the public base URL via runtime settings; stub the
// repository so tests never touch DynamoDB.
vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({
  settingsRepository: { get: async () => null, put: async () => {} },
}));
import type { Message, Task } from "@a2a-js/sdk";
import type { AgentExecutionEvent, ExecutionEventBus } from "@a2a-js/sdk/server";
import { RequestContext } from "@a2a-js/sdk/server";
import { buildAgentCard, buildProjectA2aRpcUrl } from "@/infrastructure/a2a/cards";
import {
  extractA2aImages,
  extractA2aText,
  normalizeAgentCardUrl,
} from "@/infrastructure/a2a/client";
import { ProjectA2aExecutor } from "@/application/a2a/executor";
import type { Project, Version } from "@/domain/project/types";
import type { ExecutionDeps } from "@/application/execution/runProject";
import { contentChunk, FakeChannel } from "./fakeChannel";

// --- fixtures ---------------------------------------------------------------

function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    name: "helper",
    displayName: "Helper",
    description: "A helper agent",
    projectType: "llm",
    ownerEmail: "owner@example.com",
    publishedVersion: "v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function versionFixture(overrides: Partial<Version> = {}): Version {
  return {
    projectName: "helper",
    versionName: "v1",
    systemPrompt: "You are helpful.",
    userPromptTemplate: "{{message}}",
    model: "gpt-test",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function userMessage(text: string): Message {
  return {
    kind: "message",
    messageId: "m1",
    role: "user",
    parts: [{ kind: "text", text }],
  };
}

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    kind: "task",
    id: "t1",
    contextId: "c1",
    status: { state: "completed" },
    ...overrides,
  };
}

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

// --- cards ------------------------------------------------------------------

describe("buildAgentCard", () => {
  it("builds a JSONRPC card from project and published version", async () => {
    const card = await buildAgentCard(projectFixture(), versionFixture());
    expect(card.name).toBe("Helper");
    expect(card.version).toBe("v1");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.url).toBe(await buildProjectA2aRpcUrl("helper"));
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]?.id).toBe("helper");
  });

  it("advertises image output modes for image projects", async () => {
    const card = await buildAgentCard(
      projectFixture({ projectType: "image" }),
      versionFixture({ model: "openai/gpt-image-2" }),
    );
    expect(card.defaultOutputModes).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });
});

// --- outbound text extraction ----------------------------------------------

describe("extractA2aText", () => {
  it("returns message part text", () => {
    expect(
      extractA2aText({
        kind: "message",
        messageId: "m2",
        role: "agent",
        parts: [
          { kind: "text", text: "hello " },
          { kind: "text", text: "world" },
        ],
      }),
    ).toBe("hello world");
  });

  it("prefers artifacts over the final status message", () => {
    const task = taskFixture({
      artifacts: [{ artifactId: "result", parts: [{ kind: "text", text: "artifact answer" }] }],
      status: {
        state: "completed",
        message: {
          kind: "message",
          messageId: "m3",
          role: "agent",
          parts: [{ kind: "text", text: "summary repeated" }],
        },
      },
    });
    expect(extractA2aText(task)).toBe("artifact answer");
  });

  it("falls back to status message, then agent history", () => {
    const statusOnly = taskFixture({
      status: {
        state: "completed",
        message: {
          kind: "message",
          messageId: "m4",
          role: "agent",
          parts: [{ kind: "text", text: "from status" }],
        },
      },
    });
    expect(extractA2aText(statusOnly)).toBe("from status");

    const historyOnly = taskFixture({
      history: [
        userMessage("question"),
        {
          kind: "message",
          messageId: "m5",
          role: "agent",
          parts: [{ kind: "text", text: "from history" }],
        },
      ],
    });
    expect(extractA2aText(historyOnly)).toBe("from history");
  });
});

describe("extractA2aImages", () => {
  it("extracts base64 image file parts from artifacts", () => {
    const task = taskFixture({
      artifacts: [
        {
          artifactId: "image",
          parts: [
            {
              kind: "file",
              file: { bytes: "aW1n", mimeType: "image/png", name: "generated.png" },
            },
            {
              kind: "file",
              file: { bytes: "cGRm", mimeType: "application/pdf", name: "ignored.pdf" },
            },
          ],
        },
      ],
    });
    expect(extractA2aImages(task)).toEqual([
      { b64: "aW1n", mimeType: "image/png", name: "generated.png" },
    ]);
  });
});

describe("normalizeAgentCardUrl", () => {
  it("appends the well-known path to base URLs and keeps card URLs", () => {
    expect(normalizeAgentCardUrl("https://x.test/api/a2a/p")).toBe(
      "https://x.test/api/a2a/p/.well-known/agent-card.json",
    );
    expect(normalizeAgentCardUrl("https://x.test/api/a2a/p/.well-known/agent-card.json")).toBe(
      "https://x.test/api/a2a/p/.well-known/agent-card.json",
    );
  });
});

// --- inbound executor -------------------------------------------------------

function executionDepsFixture(channel: FakeChannel): ExecutionDeps {
  const reject = () => Promise.reject(new Error("not used in this test"));
  return {
    projects: { get: reject, list: reject, put: reject, delete: reject },
    versions: { get: reject, list: reject, put: reject, delete: reject },
    skills: { get: reject, list: reject, put: reject, delete: reject },
    mcps: { get: reject, list: reject, put: reject, delete: reject },
    externalAgents: { get: reject, list: reject, put: reject, delete: reject },
    usage: { record: async () => {}, listByProject: reject, listByDateRange: reject },
    channel,
    imageChannel: {
      generateImage: async () => ({
        b64: "aW1n",
        mimeType: "image/png",
        usage: { textInputTokens: 1, imageInputTokens: 0, imageOutputTokens: 2 },
      }),
    },
  } as unknown as ExecutionDeps;
}

describe("ProjectA2aExecutor", () => {
  it("publishes task, working, result artifact, and completed", async () => {
    const channel = new FakeChannel([[contentChunk("streamed answer")]]);
    const executor = new ProjectA2aExecutor(
      executionDepsFixture(channel),
      projectFixture(),
      versionFixture(),
    );
    const bus = new CollectingBus();
    await executor.execute(new RequestContext(userMessage("hi"), "t1", "c1"), bus);

    const kinds = bus.events.map((event) => event.kind);
    expect(kinds[0]).toBe("task");
    expect(kinds).toContain("artifact-update");
    const last = bus.events.at(-1);
    expect(last?.kind).toBe("status-update");
    expect(last && "status" in last ? last.status.state : undefined).toBe("completed");

    const artifact = bus.events.find((event) => event.kind === "artifact-update");
    expect(artifact && "artifact" in artifact ? artifact.artifact.parts : []).toEqual([
      { kind: "text", text: "streamed answer" },
    ]);
  });

  it("runs image projects through the image channel and publishes a file artifact", async () => {
    const executor = new ProjectA2aExecutor(
      executionDepsFixture(new FakeChannel([])),
      projectFixture({ projectType: "image" }),
      versionFixture({ model: "openai/gpt-image-2" }),
    );
    const bus = new CollectingBus();
    await executor.execute(new RequestContext(userMessage("고양이를 그려줘"), "t1", "c1"), bus);

    const artifact = bus.events.find((event) => event.kind === "artifact-update");
    expect(artifact && "artifact" in artifact ? artifact.artifact.parts : []).toEqual([
      {
        kind: "file",
        file: { bytes: "aW1n", mimeType: "image/png", name: "generated.png" },
      },
    ]);
    const last = bus.events.at(-1);
    expect(last && "status" in last ? last.status.state : undefined).toBe("completed");
  });
});
