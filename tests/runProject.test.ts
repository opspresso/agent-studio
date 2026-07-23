import { describe, expect, it, vi } from "vitest";

// Deterministic SSRF verdicts: block `.internal` hosts without real DNS lookups.
vi.mock("@/infrastructure/net/ssrfGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/infrastructure/net/ssrfGuard")>();
  return {
    ...actual,
    assertPublicUrl: async (url: string) => {
      if (new URL(url).hostname.endsWith(".internal")) {
        throw new actual.SsrfError(`URL is not allowed: ${url}`);
      }
    },
  };
});

import { executeAgent, executeVersion } from "@/application/execution/runProject";
import type { ExecutionDeps } from "@/application/execution/runProject";
import { MODEL_CONFIGS } from "@/domain/llm/models";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version, VersionParameters } from "@/domain/project/types";
import type { UsageDelta } from "@/domain/usage/types";
import type { Trace } from "@/domain/trace/types";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";

const DEFAULT_IMAGE_MODEL = MODEL_CONFIGS.find((m) => m.capabilities.imageGeneration)?.id;

function projectFixture(): Project {
  return {
    name: "painter",
    displayName: "Painter",
    description: "",
    projectType: "agent",
    ownerEmail: "owner@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function versionFixture(parameters: VersionParameters): Version {
  return {
    projectName: "painter",
    versionName: "v1",
    systemPrompt: "You are helpful.",
    userPromptTemplate: "",
    model: "gpt-test",
    parameters,
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function executionDepsFixture(channel: FakeChannel) {
  const reject = () => Promise.reject(new Error("not used in this test"));
  const recorded: UsageDelta[] = [];
  const imageModels: string[] = [];
  const imageChannel: ImageChannel = {
    async generateImage(params) {
      imageModels.push(params.model);
      return {
        b64: "aW1n",
        mimeType: "image/png",
        usage: { textInputTokens: 10, imageInputTokens: 0, imageOutputTokens: 100 },
      };
    },
  };
  const deps = {
    projects: { get: reject, list: reject, put: reject, delete: reject },
    versions: { get: reject, list: reject, put: reject, delete: reject },
    skills: { get: reject, list: reject, put: reject, delete: reject },
    mcps: { get: reject, list: reject, put: reject, delete: reject },
    externalAgents: { get: reject, list: reject, put: reject, delete: reject },
    usage: {
      record: async (delta: UsageDelta) => {
        recorded.push(delta);
      },
      listByProject: reject,
      listByDateRange: reject,
    },
    channel,
    imageChannel,
  } as unknown as ExecutionDeps;
  return { deps, recorded, imageModels };
}

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

function offersImageTool(channel: FakeChannel): boolean {
  return channel.seenParams[0]?.tools?.some((t) => t.function.name === "GenerateImage") ?? false;
}

const imageCallScript = [
  [toolCallChunk(0, "call_img", "GenerateImage", '{"prompt":"a red fox"}'), usageChunk(10, 5)],
  [contentChunk("Here is your fox."), usageChunk(8, 4)],
];

describe("executeAgent GenerateImage opt-in", () => {
  it("offers the tool when the version sets imageGeneration: true", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: versionFixture({ piiFiltering: false, imageGeneration: true }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(offersImageTool(channel)).toBe(true);
  });

  it("does not offer the tool when the field is absent", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: versionFixture({ piiFiltering: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(offersImageTool(channel)).toBe(false);
  });

  it("does not offer the tool when imageGeneration is false", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: versionFixture({ piiFiltering: false, imageGeneration: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(offersImageTool(channel)).toBe(false);
  });

  it("uses the version's imageModel and records usage against it", async () => {
    const channel = new FakeChannel(imageCallScript);
    const { deps, recorded, imageModels } = executionDepsFixture(channel);
    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: versionFixture({
          piiFiltering: false,
          imageGeneration: true,
          imageModel: "google/gemini-3-pro-image",
        }),
        messages: [{ role: "user", content: "draw a fox" }],
      }),
    );
    expect(imageModels).toEqual(["google/gemini-3-pro-image"]);
    expect(chunks.find((c) => c.image)?.image).toMatchObject({ b64: "aW1n", prompt: "a red fox" });
    expect(recorded.some((d) => d.model === "google/gemini-3-pro-image")).toBe(true);
  });

  it("falls back to the default image model when imageModel is unset", async () => {
    const channel = new FakeChannel(imageCallScript);
    const { deps, imageModels } = executionDepsFixture(channel);
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: versionFixture({ piiFiltering: false, imageGeneration: true }),
        messages: [{ role: "user", content: "draw a fox" }],
      }),
    );
    expect(imageModels).toEqual([DEFAULT_IMAGE_MODEL]);
  });

  it("falls back to the default image model when the stored imageModel left the registry", async () => {
    const channel = new FakeChannel(imageCallScript);
    const { deps, imageModels } = executionDepsFixture(channel);
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: versionFixture({
          piiFiltering: false,
          imageGeneration: true,
          imageModel: "removed/model",
        }),
        messages: [{ role: "user", content: "draw a fox" }],
      }),
    );
    expect(imageModels).toEqual([DEFAULT_IMAGE_MODEL]);
  });
});

describe("executeAgent PII filtering", () => {
  it("passes the version toggle to the engine", async () => {
    const channel = new FakeChannel([[contentChunk("Contact the masked value."), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: versionFixture({ piiFiltering: true }),
        messages: [{ role: "user", content: "email@example.com or 010-1234-5678" }],
      }),
    );

    const sent = String(channel.seenParams[0]?.messages[0]?.content);
    expect(sent).not.toContain("email@example.com");
    expect(sent).not.toContain("010-1234-5678");
  });
});

describe("executeAgent MCP dispatch SSRF re-check", () => {
  it("skips an MCP server whose URL fails the dispatch-time SSRF check", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called for a blocked MCP server");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
      const { deps } = executionDepsFixture(channel);
      deps.mcps.get = (async () => ({
        name: "internal-mcp",
        url: "http://mcp.internal/mcp",
        headers: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })) as ExecutionDeps["mcps"]["get"];

      const chunks = await collect(
        executeAgent(deps, {
          project: projectFixture(),
          version: { ...versionFixture({ piiFiltering: false }), mcpList: ["internal-mcp"] },
          messages: [{ role: "user", content: "hi" }],
        }),
      );

      // The blocked server never gets an outbound request and offers no tools,
      // while the run itself still completes normally.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(channel.seenParams[0]?.tools ?? []).toEqual([]);
      expect(warn).toHaveBeenCalled();
      expect(chunks.some((c) => c.error)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });
});

describe("executeAgent local subagent projectType dispatch", () => {
  it("runs an image-project child through image generation, never chat/completions", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"painter-img","message":"a cat"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("Here you go."), usageChunk(1, 1)],
    ]);
    const { deps, recorded, imageModels } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) =>
      name === "painter-img"
        ? { ...projectFixture(), name: "painter-img", projectType: "image" }
        : null) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string, versionName: string) =>
      projectName === "painter-img" && versionName === "published"
        ? {
            ...versionFixture({ piiFiltering: false }),
            projectName: "painter-img",
            model: "google/gemini-3-pro-image",
          }
        : null) as ExecutionDeps["versions"]["get"];

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          subagentList: [{ name: "painter-img", type: "local" }],
        },
        messages: [{ role: "user", content: "고양이 그려줘" }],
      }),
    );

    // The child's image model runs through the image channel only.
    expect(imageModels).toEqual(["google/gemini-3-pro-image"]);
    expect(channel.seenParams.every((p) => p.model === "gpt-test")).toBe(true);

    const imageChunk = chunks.find((c) => c.image);
    expect(imageChunk?.author).toBe("painter-img");
    expect(imageChunk?.image?.prompt).toBe("a cat");
    expect(chunks.some((c) => c.error)).toBe(false);
    // Usage is billed to the child project under its image model.
    expect(
      recorded.some((d) => d.projectName === "painter-img" && d.model === "google/gemini-3-pro-image"),
    ).toBe(true);
  });
});

describe("execution tracing policy", () => {
  function captureTraces(deps: ExecutionDeps): Trace[] {
    const traces: Trace[] = [];
    deps.traces = {
      async put(trace) {
        traces.push(trace);
      },
      async get() {
        return null;
      },
      async listByProject() {
        return traces;
      },
    };
    return traces;
  }

  it("always traces agent runs", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    deps.traceSampleRate = 0;
    const traces = captureTraces(deps);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: versionFixture({ piiFiltering: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(traces).toHaveLength(1);
    expect(traces[0]?.spans.some((span) => span.kind === "model")).toBe(true);
  });

  it("honors the configured sampling rate for non-agent runs", async () => {
    const skippedChannel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const skippedFixture = executionDepsFixture(skippedChannel);
    skippedFixture.deps.traceSampleRate = 0;
    const skipped = captureTraces(skippedFixture.deps);
    const project = { ...projectFixture(), projectType: "llm" as const };

    await executeVersion(skippedFixture.deps, {
      project,
      version: versionFixture({ piiFiltering: false }),
    });
    expect(skipped).toHaveLength(0);

    const tracedChannel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const tracedFixture = executionDepsFixture(tracedChannel);
    tracedFixture.deps.traceSampleRate = 1;
    const traced = captureTraces(tracedFixture.deps);
    await executeVersion(tracedFixture.deps, {
      project,
      version: versionFixture({ piiFiltering: false }),
    });
    expect(traced).toHaveLength(1);
  });
});
