import { describe, expect, it, vi } from "vitest";

const { sendA2aMessageMock } = vi.hoisted(() => ({
  sendA2aMessageMock: vi.fn(),
}));

vi.mock("@/infrastructure/a2a/client", () => ({
  sendA2aMessage: sendA2aMessageMock,
}));

import {
  collectRun,
  executeAgent,
  executeProject,
  executeProjectStream,
  executeVersion,
  streamProjectRun,
} from "@/application/execution/runProject";
import { statusForError, ValidationError } from "@/application/errors";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { remoteAgentDispatcher } from "@/infrastructure/agent/dispatcher";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";

// Deterministic SSRF verdicts: block `.internal` hosts without real DNS lookups.
// Injected rather than module-mocked, now that the policy is a port.
const testUrlPolicy: UrlPolicy = {
  async assertAllowed(url) {
    if (new URL(url).hostname.endsWith(".internal")) {
      throw new BlockedUrlError(`URL is not allowed: ${url}`);
    }
  },
};
import type { ExecutionDeps } from "@/application/execution/runProject";
import { withRunDeadline } from "@/shared/runDeadline";
import { MODEL_CONFIGS } from "@/domain/llm/models";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version, VersionParameters } from "@/domain/project/types";
import type { UsageDelta } from "@/domain/usage/types";
import type { Trace } from "@/domain/trace/types";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";
import { fakeSkillRepository } from "./fakeSkills";

const DEFAULT_IMAGE_MODEL = MODEL_CONFIGS.find((m) => m.capabilities.imageGeneration)?.id;

function projectFixture(): Project {
  return {
    name: "painter",
    displayName: "Painter",
    description: "",
    projectType: "agent",
    ownerEmail: "owner@example.com",
    publishedVersion: "v1",
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

/** Pinned so the clock line a prompt carries is deterministic. */
const TEST_NOW = new Date("2026-07-30T06:12:00Z");
/** What {@link TEST_NOW} renders as, behind the engine-block boundary. */
const CLOCK_LINE =
  'Current date and time: 2026-07-30 (Thursday) 06:12 UTC. Resolve anything relative — "today", "yesterday", "last week", "this quarter" — from this line rather than from what you remember.';

function executionDepsFixture(channel: FakeChannel) {
  const reject = () => Promise.reject(new Error("not used in this test"));
  const recorded: UsageDelta[] = [];
  const imageModels: string[] = [];
  const edits: Array<{ model: string; prompt: string; sources: string[] }> = [];
  const imageChannel: ImageChannel = {
    async generateImage(params) {
      imageModels.push(params.model);
      return {
        b64: "aW1n",
        mimeType: "image/png",
        usage: { textInputTokens: 10, imageInputTokens: 0, imageOutputTokens: 100 },
      };
    },
    async editImage(params) {
      edits.push({
        model: params.model,
        prompt: params.prompt,
        sources: params.images.map((image) => image.b64),
      });
      return {
        b64: "ZWRpdA==",
        mimeType: "image/png",
        usage: { textInputTokens: 5, imageInputTokens: 20, imageOutputTokens: 60 },
      };
    },
  };
  const deps = {
    now: () => TEST_NOW,
    projects: { get: reject, list: reject, put: reject, delete: reject },
    versions: { get: reject, list: reject, put: reject, delete: reject },
    skills: fakeSkillRepository(reject),
    mcps: { get: reject, list: reject, put: reject, delete: reject },
    externalAgents: { get: reject, list: reject, put: reject, delete: reject },
    usage: {
      record: async (delta: UsageDelta) => {
        recorded.push(delta);
      },
      getDay: async () => null,
      claimAlert: async () => false,
      listActorsByProject: reject,
      listByProject: reject,
      listByDateRange: reject,
    },
    channel,
    imageChannel,
    cipher: secretCipher,
    urlPolicy: testUrlPolicy,
    remoteAgents: remoteAgentDispatcher,
    mcpSessions: mcpSessionFactory,
  } as unknown as ExecutionDeps;
  return { deps, recorded, imageModels, edits };
}

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Collect the traces a run persists, for tests that assert on them. */
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

function offersImageTool(channel: FakeChannel): boolean {
  return channel.seenParams[0]?.tools?.some((t) => t.function.name === "GenerateImage") ?? false;
}

describe("withRunDeadline", () => {
  it("composes a caller signal so its abort still propagates", () => {
    const controller = new AbortController();
    const composed = withRunDeadline(controller.signal);
    expect(composed).toBeInstanceOf(AbortSignal);
    expect(composed).not.toBe(controller.signal);
    expect(composed.aborted).toBe(false);
    controller.abort();
    expect(composed.aborted).toBe(true);
  });

  it("returns a live (not-yet-aborted) deadline signal when there is no caller signal", () => {
    const composed = withRunDeadline(undefined);
    expect(composed).toBeInstanceOf(AbortSignal);
    expect(composed.aborted).toBe(false);
  });
});

describe("execution cancellation", () => {
  it("propagates caller cancellation to the LLM channel through the run deadline", async () => {
    const channel = new FakeChannel([[contentChunk("done"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    const abortController = new AbortController();

    await executeVersion(deps, {
      project: projectFixture(),
      version: versionFixture({ piiFiltering: false }),
      signal: abortController.signal,
    });

    // The channel receives a deadline-composed signal (not the caller's own),
    // but a caller abort still flows through it.
    const sent = channel.seenParams[0]?.signal;
    expect(sent).toBeInstanceOf(AbortSignal);
    expect(sent).not.toBe(abortController.signal);
    expect(sent?.aborted).toBe(false);
    abortController.abort();
    expect(sent?.aborted).toBe(true);
  });
});

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

  it("hands both builtins the same model when the stored one is stale", async () => {
    // What `resolveImageModel` is for. The two builders used to compute this
    // separately from the same inputs — the copy was the risk, not a behaviour
    // difference — so the invariant worth pinning is that a run's draw and its
    // redraw reach the same model, and that the fallback is reported.
    const lines: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: string) => {
      lines.push(line);
    });
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_gen", "GenerateImage", '{"prompt":"a fox"}'), usageChunk(1, 1)],
      [
        toolCallChunk(0, "call_edit", "EditImage", '{"image_id":"img_1","prompt":"at night"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("Done."), usageChunk(1, 1)],
    ]);
    const { deps, imageModels, edits } = executionDepsFixture(channel);
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: versionFixture({
          piiFiltering: false,
          imageGeneration: true,
          imageModel: "removed/model",
        }),
        messages: [{ role: "user", content: "draw a fox, then make it night" }],
      }),
    );
    warn.mockRestore();

    expect(imageModels).toEqual([DEFAULT_IMAGE_MODEL]);
    expect(edits).toEqual([
      { model: DEFAULT_IMAGE_MODEL, prompt: "at night", sources: ["aW1n"] },
    ]);
    expect(lines.some((line) => line.includes("removed/model"))).toBe(true);
  });
});

describe("executeAgent EditImage", () => {
  const ATTACHED = "data:image/png;base64,YXR0YWNoZWQ=";
  /** A vision-capable model: an image-bearing run is gated on the registry. */
  const visionVersion = (parameters: VersionParameters): Version => ({
    ...versionFixture(parameters),
    model: "google/gemini-2.5-flash",
  });
  const editScript = [
    [
      toolCallChunk(0, "call_edit", "EditImage", '{"image_id":"img_1","prompt":"make it night"}'),
      usageChunk(10, 5),
    ],
    [contentChunk("Done — it is night now."), usageChunk(8, 4)],
  ];

  function offersEditTool(channel: FakeChannel): boolean {
    return channel.seenParams[0]?.tools?.some((t) => t.function.name === "EditImage") ?? false;
  }

  it("edits an attached image and records usage against the image model", async () => {
    const channel = new FakeChannel(editScript);
    const { deps, recorded, edits } = executionDepsFixture(channel);

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: visionVersion({ piiFiltering: false, imageGeneration: true }),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "make this night" },
              { type: "image_url", image_url: { url: ATTACHED } },
            ],
          },
        ],
      }),
    );

    expect(edits).toEqual([
      { model: DEFAULT_IMAGE_MODEL, prompt: "make it night", sources: ["YXR0YWNoZWQ="] },
    ]);
    expect(chunks.find((c) => c.image)?.image).toMatchObject({ b64: "ZWRpdA==" });
    const editUsage = recorded.find((d) => d.model === DEFAULT_IMAGE_MODEL);
    // 5 text + 20 image input tokens, 60 image output tokens — same accounting as generate.
    expect(editUsage?.inputTokens).toBe(25);
    expect(editUsage?.outputTokens).toBe(60);
  });

  it("lists the attached image in the system prompt so the model can name it", async () => {
    const channel = new FakeChannel(editScript);
    const { deps } = executionDepsFixture(channel);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: visionVersion({ piiFiltering: false, imageGeneration: true }),
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: ATTACHED } }] },
        ],
      }),
    );

    const systemPrompt = String(channel.seenParams[0]?.messages[0]?.content);
    expect(systemPrompt).toContain("## Available Images");
    expect(systemPrompt).toContain("| img_1 | sent by the user |");
  });

  it("returns an error tool result for an unknown image id", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_edit", "EditImage", '{"image_id":"img_9","prompt":"night"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("I could not find that image."), usageChunk(1, 1)],
    ]);
    const { deps, edits } = executionDepsFixture(channel);

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: visionVersion({ piiFiltering: false, imageGeneration: true }),
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: ATTACHED } }] },
        ],
      }),
    );

    expect(edits).toEqual([]);
    const result = chunks.find((c) => c.toolResult?.name === "EditImage")?.toolResult;
    expect(result?.content).toContain("no image with id 'img_9'");
    expect(result?.content).toContain("img_1");
  });

  it("is not offered when the version has not opted into image generation", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: visionVersion({ piiFiltering: false, imageGeneration: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(offersEditTool(channel)).toBe(false);
  });

  it("hands a generated image its own editable id", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_img", "GenerateImage", '{"prompt":"a red fox"}'), usageChunk(1, 1)],
      [
        toolCallChunk(0, "call_edit", "EditImage", '{"image_id":"img_1","prompt":"at night"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("A fox, then the same fox at night."), usageChunk(1, 1)],
    ]);
    const { deps, edits } = executionDepsFixture(channel);

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: visionVersion({ piiFiltering: false, imageGeneration: true }),
        messages: [{ role: "user", content: "draw a fox, then make it night" }],
      }),
    );

    const generated = chunks.find((c) => c.toolResult?.name === "GenerateImage")?.toolResult;
    expect(generated?.content).toContain("image id: img_1");
    // The edit ran on the bytes the generator produced, not on an attachment.
    expect(edits).toEqual([
      { model: DEFAULT_IMAGE_MODEL, prompt: "at night", sources: ["aW1n"] },
    ]);
    expect(chunks.filter((c) => c.image)).toHaveLength(2);
  });
});

describe("executeAgent image transfer to a subagent", () => {
  const ATTACHED = "data:image/png;base64,YXR0YWNoZWQ=";

  function imageProjectDeps(channel: FakeChannel) {
    const fixture = executionDepsFixture(channel);
    // The parent has one image subagent, like sample-agent -> simple-image.
    const parent = {
      ...projectFixture(),
      name: "sample-agent",
    };
    const child: Project = {
      ...projectFixture(),
      name: "simple-image",
      projectType: "image",
      publishedVersion: "1",
    };
    const childVersion: Version = {
      ...versionFixture({ piiFiltering: false }),
      projectName: "simple-image",
      model: DEFAULT_IMAGE_MODEL ?? "openai/gpt-image-2",
    };
    const deps = {
      ...fixture.deps,
      projects: { get: async (name: string) => (name === "simple-image" ? child : parent) },
      versions: {
        get: async (project: string) => (project === "simple-image" ? childVersion : null),
        list: async () => [childVersion],
      },
    } as unknown as ExecutionDeps;
    return { ...fixture, deps, parent };
  }

  const transferScript = (args: string) => [
    [toolCallChunk(0, "call_t", "transfer_to_agent", args), usageChunk(1, 1)],
    [contentChunk("Done — the image is updated."), usageChunk(1, 1)],
  ];

  /**
   * The fake channel now throws on an aborted signal, because the real one does
   * — the SDK raises `APIUserAbortError`. Until it did, the engine's
   * cancellation checkpoints could all have been deleted with the suite green.
   */
  it("stops a run when the caller aborts mid-stream", async () => {
    const controller = new AbortController();
    const channel = new FakeChannel([
      [contentChunk("first"), contentChunk("second"), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);

    const chunks: EngineChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of executeAgent(deps, {
          project: projectFixture(),
          version: versionFixture({ piiFiltering: false }),
          messages: [{ role: "user", content: "hi" }],
          signal: controller.signal,
        })) {
          chunks.push(chunk);
          controller.abort();
        }
      })(),
    ).rejects.toThrow();

    // It stopped where it was told to, rather than draining the script.
    expect(chunks.filter((chunk) => chunk.delta?.content).length).toBeLessThan(2);
  });

  /**
   * A transfer is a whole run on another project, with its own thresholds. The
   * bracket settles the project it admitted and knows about no other, and
   * `settleCostLimit` is the only thing that claims the alert — so a project
   * reached only through transfers accrued spend, began refusing at its limit
   * (its own admission check sees to that) and told nobody, because the one
   * announcement its owner could have received was never sent.
   */
  it("settles the thresholds of a project it transferred to, not just its own", async () => {
    const channel = new FakeChannel(
      transferScript('{"agent_name":"simple-image","message":"a fox"}'),
    );
    const fixture = imageProjectDeps(channel);
    const claims: Array<{ project: string; kind: string }> = [];
    const guarded = {
      ...fixture.deps,
      projects: {
        get: async (name: string) =>
          name === "simple-image"
            ? { ...(await fixture.deps.projects.get(name))!, costLimits: { alertThresholdUsd: 1 } }
            : fixture.parent,
      },
      usage: {
        ...fixture.deps.usage,
        getDay: async () => ({ costUsd: { "openai/gpt-image-2": 5 } }),
        claimAlert: async (project: string, _date: string, kind: string) => {
          claims.push({ project, kind });
          return true;
        },
      },
    } as unknown as ExecutionDeps;

    await collect(
      executeAgent(guarded, {
        project: fixture.parent,
        version: parentVersion(),
        messages: [{ role: "user", content: "draw a fox" }],
      }),
    );

    expect(claims).toEqual([{ project: "simple-image", kind: "alert" }]);
  });

  function parentVersion(): Version {
    return {
      ...versionFixture({ piiFiltering: false }),
      model: "google/gemini-2.5-flash",
      subagentList: [{ name: "simple-image", type: "local" }],
    };
  }

  it("hands the named image to an image subagent, which edits instead of drawing", async () => {
    const channel = new FakeChannel(
      transferScript('{"agent_name":"simple-image","message":"make it blue","image_ids":["img_1"]}'),
    );
    const { deps, edits, imageModels, parent } = imageProjectDeps(channel);

    const chunks = await collect(
      executeAgent(deps, {
        project: parent,
        version: parentVersion(),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "make this blue" },
              { type: "image_url", image_url: { url: ATTACHED } },
            ],
          },
        ],
      }),
    );

    expect(edits).toEqual([
      {
        model: DEFAULT_IMAGE_MODEL,
        prompt: "You are helpful.\n\nmake it blue",
        sources: ["YXR0YWNoZWQ="],
      },
    ]);
    expect(imageModels).toEqual([]); // the generate endpoint was never used
    expect(chunks.find((c) => c.image)?.image).toMatchObject({ b64: "ZWRpdA==" });
  });

  it("draws from scratch when no image is named", async () => {
    const channel = new FakeChannel(
      transferScript('{"agent_name":"simple-image","message":"draw a fox"}'),
    );
    const { deps, edits, imageModels, parent } = imageProjectDeps(channel);

    await collect(
      executeAgent(deps, {
        project: parent,
        version: parentVersion(),
        messages: [{ role: "user", content: "draw a fox" }],
      }),
    );

    expect(edits).toEqual([]);
    expect(imageModels).toEqual([DEFAULT_IMAGE_MODEL]);
  });

  it("reports an unknown image id without transferring", async () => {
    const channel = new FakeChannel(
      transferScript('{"agent_name":"simple-image","message":"edit","image_ids":["img_7"]}'),
    );
    const { deps, edits, imageModels, parent } = imageProjectDeps(channel);

    const chunks = await collect(
      executeAgent(deps, {
        project: parent,
        version: parentVersion(),
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: ATTACHED } }] },
        ],
      }),
    );

    expect(edits).toEqual([]);
    expect(imageModels).toEqual([]);
    const result = chunks.find((c) => c.toolResult?.name === "transfer_to_agent")?.toolResult;
    expect(result?.content).toContain("unknown image id");
    expect(result?.content).toContain("img_1");
  });

  it("reports a child that cannot accept the handed-over image without failing the run", async () => {
    // The child's model is not vision-capable, so engine.runAgent throws on entry
    // instead of streaming. That must reach the parent as a tool error like every
    // other refused transfer — not tear down the whole run.
    const channel = new FakeChannel(
      transferScript('{"agent_name":"text-child","message":"look","image_ids":["img_1"]}'),
    );
    const fixture = executionDepsFixture(channel);
    const childVersion: Version = {
      ...versionFixture({ piiFiltering: false }),
      projectName: "text-child",
      // Not in the model registry, so image input is rejected.
      model: "gpt-test",
    };
    const deps = {
      ...fixture.deps,
      projects: { get: async (name: string) => ({ ...projectFixture(), name }) },
      versions: { get: async () => childVersion, list: async () => [childVersion] },
    } as unknown as ExecutionDeps;

    const chunks = await collect(
      executeAgent(deps, {
        project: { ...projectFixture(), name: "sample-agent" },
        version: { ...parentVersion(), subagentList: [{ name: "text-child", type: "local" }] },
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: ATTACHED } }] },
        ],
      }),
    );

    const failure = chunks.find((c) => c.error);
    expect(failure?.author).toBe("text-child");
    expect(failure?.error).toContain("image input");
    // The parent resumed and answered, and the stream ended normally.
    expect(chunks.some((c) => c.delta?.content === "Done — the image is updated.")).toBe(true);
    expect(chunks.some((c) => c.done)).toBe(true);
  });

  it("offers image_ids and lists the images in the system prompt", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps, parent } = imageProjectDeps(channel);

    await collect(
      executeAgent(deps, {
        project: parent,
        version: parentVersion(),
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: ATTACHED } }] },
        ],
      }),
    );

    const transfer = channel.seenParams[0]?.tools?.find(
      (t) => t.function.name === "transfer_to_agent",
    );
    const properties = transfer?.function.parameters?.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("image_ids");
    const systemPrompt = String(channel.seenParams[0]?.messages[0]?.content);
    expect(systemPrompt).toContain("## Available Images");
    expect(systemPrompt).toContain("| img_1 | sent by the user |");
    expect(systemPrompt).toContain("image_ids");
  });

  it("still explains image ids on a turn that starts with no images", async () => {
    // `image_ids` is offered whenever there is an agent to transfer to, and its
    // description points at this section — so the section cannot be conditional
    // on an image already existing.
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps, parent } = imageProjectDeps(channel);

    await collect(
      executeAgent(deps, {
        project: parent,
        version: parentVersion(),
        messages: [{ role: "user", content: "draw me a cat" }],
      }),
    );

    const systemPrompt = String(channel.seenParams[0]?.messages[0]?.content);
    expect(systemPrompt).toContain("## Available Images");
    // This version has no image tools of its own AND no MCP tools, so the only
    // way an id can appear is the user attaching a picture. Naming either of the
    // other two routes would promise the model something this run cannot do.
    expect(systemPrompt).toContain("Ids appear here as images arrive — from what the user sends.");
    expect(systemPrompt).not.toContain("you generate or edit");
    expect(systemPrompt).not.toContain("a tool returns");
  });

  it("promises generated ids only to a version that can generate", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps, parent } = imageProjectDeps(channel);

    await collect(
      executeAgent(deps, {
        project: parent,
        version: { ...parentVersion(), parameters: { piiFiltering: false, imageGeneration: true } },
        messages: [{ role: "user", content: "draw me a cat" }],
      }),
    );

    const systemPrompt = String(channel.seenParams[0]?.messages[0]?.content);
    expect(systemPrompt).toContain("from what you generate or edit");
  });
});

describe("executeAgent nested transfer identity", () => {
  /** bruce-bot -> sample-agent -> simple-image, the shape the console exercises. */
  function chainDeps(channel: FakeChannel) {
    const fixture = executionDepsFixture(channel);
    const projects: Record<string, Project> = {
      "bruce-bot": { ...projectFixture(), name: "bruce-bot" },
      "sample-agent": { ...projectFixture(), name: "sample-agent" },
      "simple-image": {
        ...projectFixture(),
        name: "simple-image",
        projectType: "image",
        publishedVersion: "1",
      },
    };
    const versions: Record<string, Version> = {
      "bruce-bot": {
        ...versionFixture({ piiFiltering: false }),
        projectName: "bruce-bot",
        model: "google/gemini-2.5-flash",
        subagentList: [{ name: "sample-agent", type: "local" }],
      },
      "sample-agent": {
        ...versionFixture({ piiFiltering: false }),
        projectName: "sample-agent",
        model: "google/gemini-2.5-flash",
        subagentList: [{ name: "simple-image", type: "local" }],
      },
      "simple-image": {
        ...versionFixture({ piiFiltering: false }),
        projectName: "simple-image",
        model: DEFAULT_IMAGE_MODEL ?? "openai/gpt-image-2",
      },
    };
    const traces: Trace[] = [];
    const deps = {
      ...fixture.deps,
      projects: { get: async (name: string) => projects[name] ?? null },
      versions: { get: async (project: string) => versions[project] ?? null, list: async () => [] },
      traces: { put: async (trace: Trace) => void traces.push(trace) },
      traceSampleRate: 1,
    } as unknown as ExecutionDeps;
    return { deps, traces, top: projects["bruce-bot"] as Project, version: versions["bruce-bot"] as Version };
  }

  const chainScript = [
    // bruce-bot hands off…
    [
      toolCallChunk(0, "t1", "transfer_to_agent", '{"agent_name":"sample-agent","message":"draw"}'),
      usageChunk(1, 1),
    ],
    // …sample-agent hands off again…
    [
      toolCallChunk(0, "t2", "transfer_to_agent", '{"agent_name":"simple-image","message":"a fox"}'),
      usageChunk(2, 2),
    ],
    // …sample-agent wraps up, then bruce-bot answers.
    [contentChunk("passing it up"), usageChunk(3, 3)],
    [contentChunk("here is your fox"), usageChunk(4, 4)],
  ];

  it("reports the innermost agent and the full chain, not the first hop", async () => {
    const channel = new FakeChannel(chainScript);
    const { deps, top, version } = chainDeps(channel);

    const chunks = await collect(executeAgent(deps, { project: top, version, messages: [{ role: "user", content: "draw a fox" }] }));

    // The image came from two levels down; before this it surfaced as "sample-agent".
    const imageChunk = chunks.find((c) => c.image);
    expect(imageChunk?.author).toBe("simple-image");
    expect(imageChunk?.authorPath).toEqual(["sample-agent", "simple-image"]);
    // The middle hop still reports itself for its own output.
    const middle = chunks.find((c) => c.author === "sample-agent" && c.delta?.content);
    expect(middle?.authorPath).toEqual(["sample-agent"]);
    // Top-level answer stays unauthored, so the visible answer is unchanged.
    const answer = chunks.filter((c) => c.author === undefined && c.delta?.content);
    expect(answer.map((c) => c.delta?.content).join("")).toBe("here is your fox");
  });

  it("records the chain on every trace in the tree", async () => {
    const channel = new FakeChannel(chainScript);
    const { deps, traces, top, version } = chainDeps(channel);

    await collect(executeAgent(deps, { project: top, version, messages: [{ role: "user", content: "draw a fox" }] }));

    const byProject = new Map(traces.map((trace) => [trace.projectName, trace]));
    expect(byProject.get("bruce-bot")?.ancestry).toBeUndefined(); // the root has no caller
    expect(byProject.get("sample-agent")?.ancestry).toEqual(["bruce-bot", "sample-agent"]);
    expect(byProject.get("simple-image")?.ancestry).toEqual([
      "bruce-bot",
      "sample-agent",
      "simple-image",
    ]);

    // Each level links one step down, and names the chain it saw.
    const rootSubagent = byProject
      .get("bruce-bot")
      ?.spans.find((span) => span.kind === "subagent");
    // One span per transfer this run made, with how deep it went recorded on it.
    expect(rootSubagent?.name).toBe("sample-agent");
    expect(rootSubagent?.output?.chain).toBe("sample-agent → simple-image");
    expect(rootSubagent?.output?.subagentTraceId).toBe(byProject.get("sample-agent")?.traceId);
    const midSubagent = byProject
      .get("sample-agent")
      ?.spans.find((span) => span.kind === "subagent");
    expect(midSubagent?.output?.subagentTraceId).toBe(byProject.get("simple-image")?.traceId);
  });
});

describe("executeAgent registry bindings that no longer resolve", () => {
  /**
   * Counts the two reads a run makes of the registry separately: the table's
   * one line per skill, and the body a `Skill` call asks for.
   */
  function countSkillReads(deps: ExecutionDeps): { described: string[][]; bodies: string[] } {
    const described: string[][] = [];
    const bodies: string[] = [];
    deps.skills.describe = (async (names: readonly string[]) => {
      described.push([...names]);
      return names.includes("alive") ? [{ name: "alive", description: "still here" }] : [];
    }) as ExecutionDeps["skills"]["describe"];
    deps.skills.get = (async (name: string) => {
      bodies.push(name);
      return name === "alive"
        ? { name, description: "still here", content: "# alive", createdAt: "", updatedAt: "" }
        : null;
    }) as ExecutionDeps["skills"]["get"];
    return { described, bodies };
  }

  const boundToTwoSkills = () => ({
    ...versionFixture({ piiFiltering: false }),
    skillList: ["alive", "deleted"],
  });

  it("does not offer a skill whose registry entry is gone, and describes without reading a body", async () => {
    // A deleted skill used to be advertised with an empty description and then
    // failed on load — a wasted turn. And the table's one line per skill cost
    // the whole item: every bound skill's body and attachments crossed the wire
    // before the first token, which is the opposite of what a tool the model
    // has to *ask* for is worth.
    const channel = new FakeChannel([
      [toolCallChunk(0, "call_1", "Skill", '{"skill_name":"alive"}'), usageChunk(1, 1)],
      [toolCallChunk(0, "call_2", "Skill", '{"skill_name":"alive"}'), usageChunk(1, 1)],
      [contentChunk("loaded"), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    const reads = countSkillReads(deps);

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: boundToTwoSkills(),
        messages: [{ role: "user", content: "use a skill" }],
      }),
    );

    const skillTool = channel.seenParams[0]?.tools?.find((t) => t.function.name === "Skill");
    const properties = skillTool?.function.parameters?.properties as
      | { skill_name?: { enum?: string[]; description?: string } }
      | undefined;
    expect(properties?.skill_name?.enum).toEqual(["alive"]);
    expect(properties?.skill_name?.description).not.toContain("deleted");
    const systemPrompt = String(channel.seenParams[0]?.messages[0]?.content);
    expect(systemPrompt).toContain("| alive | still here |");
    expect(systemPrompt).not.toContain("deleted");
    // Both bindings asked about together, and neither cost a body.
    expect(reads.described).toEqual([["alive", "deleted"]]);
    // Two calls for the same skill, one body read: the loader's cache still holds.
    expect(reads.bodies).toEqual(["alive"]);
    expect(chunks.filter((c) => c.toolResult).map((c) => c.toolResult?.content)).toEqual([
      "# alive",
      "# alive",
    ]);
  });

  it("reads no skill body at all when the model never calls the tool", async () => {
    // The case the split is for. The table is assembled, the tool is offered,
    // and nothing about the run touches a SKILL.md body — which is what the
    // model asking for one is supposed to mean.
    const channel = new FakeChannel([[contentChunk("answered without a skill"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    const reads = countSkillReads(deps);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: boundToTwoSkills(),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(reads.described).toEqual([["alive", "deleted"]]);
    expect(reads.bodies).toEqual([]);
  });

  it("does not offer a transfer to a project that no longer exists", async () => {
    const channel = new FakeChannel([[contentChunk("answered myself"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) =>
      name === "alive-agent" ? { ...projectFixture(), name } : null) as ExecutionDeps["projects"]["get"];

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          subagentList: [
            { name: "alive-agent", type: "local" },
            { name: "deleted-agent", type: "local" },
          ],
        },
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const transfer = channel.seenParams[0]?.tools?.find(
      (t) => t.function.name === "transfer_to_agent",
    );
    const agentName = (
      transfer?.function.parameters?.properties as { agent_name?: { enum?: string[] } } | undefined
    )?.agent_name;
    expect(agentName?.enum).toEqual(["alive-agent"]);
    expect(String(channel.seenParams[0]?.messages[0]?.content)).not.toContain("deleted-agent");
  });
});

describe("executeAgent reports the bindings it could not use", () => {
  it("warns about a deleted skill and a deleted subagent before the answer, and records it on the trace", async () => {
    // Dropping these silently is indistinguishable from a model that simply
    // chose not to call anything — the run looks fine and answers worse.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const channel = new FakeChannel([[contentChunk("answered"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    const traces = captureTraces(deps);
    deps.skills.get = (async () => null) as ExecutionDeps["skills"]["get"];
    deps.projects.get = (async () => null) as ExecutionDeps["projects"]["get"];

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          skillList: ["gone-skill"],
          subagentList: [{ name: "gone-agent", type: "local" }],
        },
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const warnings = chunks.flatMap((chunk) => (chunk.warning ? [chunk.warning] : []));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("gone-skill");
    expect(warnings[1]).toContain("gone-agent");
    // They arrive before any answer text, so the reader sees them in context.
    const firstWarning = chunks.findIndex((chunk) => chunk.warning);
    const firstContent = chunks.findIndex((chunk) => chunk.delta?.content);
    expect(firstWarning).toBeLessThan(firstContent);
    // A warning is not a failure: the run still completes and answers.
    expect(chunks.some((chunk) => chunk.error)).toBe(false);
    expect(chunks.some((chunk) => chunk.done)).toBe(true);

    expect(traces[0]?.warnings).toHaveLength(2);
    expect(traces[0]?.status).toBe("completed");
    warn.mockRestore();
  });

  it("warns about an MCP server that is no longer in the registry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const channel = new FakeChannel([[contentChunk("answered"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    deps.mcps.get = (async () => null) as ExecutionDeps["mcps"]["get"];

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          mcpList: [{ name: "gone-mcp" }],
        },
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.flatMap((chunk) => (chunk.warning ? [chunk.warning] : []))).toEqual([
      expect.stringContaining("gone-mcp"),
    ]);
    warn.mockRestore();
  });

  it("says nothing when every binding resolves", async () => {
    const channel = new FakeChannel([[contentChunk("answered"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    deps.skills.get = (async (name: string) => ({
      name,
      description: "here",
      content: "# here",
      createdAt: "",
      updatedAt: "",
    })) as ExecutionDeps["skills"]["get"];

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: { ...versionFixture({ piiFiltering: false }), skillList: ["here"] },
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.some((chunk) => chunk.warning)).toBe(false);
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
          version: { ...versionFixture({ piiFiltering: false }), mcpList: [{ name: "internal-mcp" }] },
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
      projectName === "painter-img" && versionName === "v1"
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

  it("prepends the image child's own system prompt as style on a transfer", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"painter-img","message":"a cat"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("Here you go."), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    const seen: string[] = [];
    const drawUnstyled = deps.imageChannel.generateImage;
    deps.imageChannel.generateImage = async (params) => {
      seen.push(params.prompt);
      return drawUnstyled(params);
    };
    deps.projects.get = (async (name: string) =>
      name === "painter-img"
        ? { ...projectFixture(), name: "painter-img", projectType: "image" }
        : null) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string, versionName: string) =>
      projectName === "painter-img" && versionName === "v1"
        ? {
            ...versionFixture({ piiFiltering: false }),
            projectName: "painter-img",
            model: "google/gemini-3-pro-image",
            systemPrompt: "Watercolor, no text.",
          }
        : null) as ExecutionDeps["versions"]["get"];

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          subagentList: [{ name: "painter-img", type: "local" }],
        },
        messages: [{ role: "user", content: "고양이 그려줘" }],
      }),
    );

    expect(seen).toEqual(["Watercolor, no text.\n\na cat"]);
  });

  it("says why an image child came back with nothing, rather than leaving the model to guess", async () => {
    // The reported failure, end to end. The provider refuses, `runImageSubagent`
    // reports it as an authored `error` chunk and returns "" — and every
    // consumer drops authored errors, on the grounds that the parent answers
    // past them. It did answer, but until the transfer folded the reason into
    // its context it had none, and wrote one of its own.
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"painter-img","message":"a cat"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("The image was refused."), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    deps.imageChannel.generateImage = async () => {
      throw new Error("400 rejected by the safety system. safety_violations=[sexual].");
    };
    deps.projects.get = (async (name: string) =>
      name === "painter-img"
        ? { ...projectFixture(), name: "painter-img", projectType: "image" }
        : null) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string, versionName: string) =>
      projectName === "painter-img" && versionName === "v1"
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

    // The child still reports the way it always did, and draws nothing.
    const failure = chunks.find((chunk) => chunk.error);
    expect(failure?.author).toBe("painter-img");
    expect(failure?.error).toContain("safety system");
    expect(chunks.some((chunk) => chunk.image)).toBe(false);

    // The reader is told, on a channel nothing filters by author.
    const warning = chunks.find((chunk) => chunk.warning);
    expect(warning?.author).toBeUndefined();
    expect(warning?.warning).toContain("painter-img");
    expect(warning?.warning).toContain("safety system");

    // And so is the model, in the very turn it answers from.
    const context = (channel.seenParams[1]?.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(context).toContain("safety system");
  });

  it("answers a prompt-project child through its user prompt template", async () => {
    // A prompt project's behaviour IS its template. Sending the transfer down
    // the tool loop drops it and the child answers from a bare system prompt.
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"summarizer","message":"three otters"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("Summarized."), usageChunk(1, 1)],
      [contentChunk("Passed on."), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) =>
      name === "summarizer"
        ? { ...projectFixture(), name: "summarizer", projectType: "llm" }
        : null) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string, versionName: string) =>
      projectName === "summarizer" && versionName === "v1"
        ? {
            ...versionFixture({ piiFiltering: false }),
            projectName: "summarizer",
            systemPrompt: "You summarize.",
            userPromptTemplate: "Answer in exactly one sentence.",
          }
        : null) as ExecutionDeps["versions"]["get"];

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          subagentList: [{ name: "summarizer", type: "local" }],
        },
        messages: [{ role: "user", content: "summarize this" }],
      }),
    );

    const childRequest = channel.seenParams[1];
    expect(childRequest?.messages.map((m) => m.content)).toEqual([
      `You summarize.\n\n---\n\n${CLOCK_LINE}`,
      "Answer in exactly one sentence.",
      "three otters",
    ]);
    // No tool loop: the child was never offered tools.
    expect(childRequest?.tools).toBeUndefined();
    expect(chunks.some((c) => c.error)).toBe(false);
    expect(chunks.find((c) => c.author === "summarizer" && c.delta?.content)?.delta?.content).toBe(
      "Summarized.",
    );
  });

  it("pins the clock for the whole run, so a child cannot say a different now", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(
          0,
          "call_t",
          "transfer_to_agent",
          '{"agent_name":"summarizer","message":"three otters"}',
        ),
        usageChunk(1, 1),
      ],
      [contentChunk("Summarized."), usageChunk(1, 1)],
      [contentChunk("Passed on."), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    // A clock that advances on every read, across midnight. Unpinned, the child
    // would stamp its prompt with a later instant than its parent — here, a
    // different date and weekday, which is exactly the confusion the clock is
    // meant to remove.
    const instants = [new Date("2026-07-30T23:59:59Z"), new Date("2026-07-31T00:00:01Z")];
    let reads = 0;
    deps.now = () => instants[Math.min(reads++, instants.length - 1)] as Date;
    deps.projects.get = (async (name: string) =>
      name === "summarizer"
        ? { ...projectFixture(), name: "summarizer", projectType: "llm" }
        : null) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string, versionName: string) =>
      projectName === "summarizer" && versionName === "v1"
        ? {
            ...versionFixture({ piiFiltering: false }),
            projectName: "summarizer",
            systemPrompt: "You summarize.",
            userPromptTemplate: "Answer in exactly one sentence.",
          }
        : null) as ExecutionDeps["versions"]["get"];

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          subagentList: [{ name: "summarizer", type: "local" }],
        },
        messages: [{ role: "user", content: "summarize this" }],
      }),
    );

    const parentSystem = String(channel.seenParams[0]?.messages[0]?.content);
    const childSystem = String(channel.seenParams[1]?.messages[0]?.content);
    expect(parentSystem).toContain("2026-07-30 (Thursday) 23:59 UTC");
    expect(childSystem).toContain("2026-07-30 (Thursday) 23:59 UTC");
    expect(childSystem).not.toContain("2026-07-31");
  });
});

describe("executeAgent hands the conversation to a transferred agent", () => {
  /** A parent whose only subagent is a local agent project named `child`. */
  function chainDeps(channel: FakeChannel) {
    const { deps, ...rest } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) =>
      name === "child" ? { ...projectFixture(), name: "child" } : null) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string) =>
      projectName === "child"
        ? { ...versionFixture({ piiFiltering: false }), projectName: "child" }
        : null) as ExecutionDeps["versions"]["get"];
    return { deps, ...rest };
  }

  const transferThenAnswer = (message: string) => [
    [
      toolCallChunk(0, "call_t", "transfer_to_agent", JSON.stringify({ agent_name: "child", message })),
      usageChunk(1, 1),
    ],
    [contentChunk("Child answer."), usageChunk(1, 1)],
    [contentChunk("Passed on."), usageChunk(1, 1)],
  ];

  function parentVersion() {
    return {
      ...versionFixture({ piiFiltering: false }),
      subagentList: [{ name: "child", type: "local" as const }],
    };
  }

  it("carries the earlier turns a follow-up refers to", async () => {
    // "make it bigger" is meaningless to an agent that never saw what was made.
    const channel = new FakeChannel(transferThenAnswer("make it bigger"));
    const { deps } = chainDeps(channel);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: parentVersion(),
        messages: [
          { role: "user", content: "draw a cat" },
          { role: "assistant", content: "Here is an orange cat." },
          { role: "user", content: "make it bigger" },
        ],
      }),
    );

    const childTurn = String(channel.seenParams[1]?.messages.at(-1)?.content);
    expect(childTurn).toContain("## Conversation so far");
    expect(childTurn).toContain("User: draw a cat");
    // The parent's own turns are labelled with the parent, so the child can
    // tell whose answers these were instead of reading them as its own.
    expect(childTurn).toContain(`${projectFixture().name}: Here is an orange cat.`);
    expect(childTurn).toContain("## Request\n\nmake it bigger");
    // The turn being answered is the request, not context: sending it twice
    // would double the child's input and say nothing new.
    expect(childTurn.match(/make it bigger/g)).toHaveLength(1);
  });

  it("records the child's failure when its tool resolution throws", async () => {
    // A recorder writes its row in `finish()` and nowhere else, so a resolve
    // that threw outside the try left the child with no trace at all — while
    // the identical failure one level up recorded a `failed` one.
    const channel = new FakeChannel(transferThenAnswer("summarize this"));
    const { deps } = chainDeps(channel);
    // The child binds a skill and the fixture's skill repository rejects every
    // read. The parent binds none, so only the child's resolve reaches it.
    deps.versions.get = (async (projectName: string) =>
      projectName === "child"
        ? {
            ...versionFixture({ piiFiltering: false }),
            projectName: "child",
            skillList: ["unreadable"],
          }
        : null) as ExecutionDeps["versions"]["get"];
    const traces = captureTraces(deps);

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: parentVersion(),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    // The transfer fails as a tool error and the parent still answers past it…
    expect(chunks.some((chunk) => chunk.author === "child" && chunk.error)).toBe(true);
    // …and what failed is on record at the level it failed at.
    expect(traces.find((trace) => trace.projectName === "child")?.status).toBe("failed");
  });

  it("sends a first-turn transfer exactly as before, with no context block", async () => {
    // A conversation of one turn has no "so far" — framing one would be noise.
    const channel = new FakeChannel(transferThenAnswer("draw a cat"));
    const { deps } = chainDeps(channel);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: parentVersion(),
        messages: [{ role: "user", content: "draw a cat" }],
      }),
    );

    expect(String(channel.seenParams[1]?.messages.at(-1)?.content)).toBe("draw a cat");
  });

  it("hands a grandchild the original conversation, not a transcript of a transcript", async () => {
    // The child's own messages are the one synthetic turn it was handed, so a
    // re-derived transcript would nest each hop's block inside the next.
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "t1", "transfer_to_agent", '{"agent_name":"child","message":"first hop"}'),
        usageChunk(1, 1),
      ],
      [
        toolCallChunk(0, "t2", "transfer_to_agent", '{"agent_name":"child2","message":"second hop"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("Grandchild answer."), usageChunk(1, 1)],
      [contentChunk("Child wraps up."), usageChunk(1, 1)],
      [contentChunk("Parent wraps up."), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) =>
      name === "child" || name === "child2"
        ? { ...projectFixture(), name }
        : null) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string) =>
      projectName === "child"
        ? {
            ...versionFixture({ piiFiltering: false }),
            projectName: "child",
            subagentList: [{ name: "child2", type: "local" as const }],
          }
        : projectName === "child2"
          ? { ...versionFixture({ piiFiltering: false }), projectName: "child2" }
          : null) as ExecutionDeps["versions"]["get"];

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: parentVersion(),
        messages: [
          { role: "user", content: "draw a cat" },
          { role: "assistant", content: "Here is an orange cat." },
          { role: "user", content: "make it bigger" },
        ],
      }),
    );

    const grandchildTurn = String(channel.seenParams[2]?.messages.at(-1)?.content);
    expect(grandchildTurn).toContain("User: draw a cat");
    expect(grandchildTurn).toContain("## Request\n\nsecond hop");
    // One context block, holding the user's conversation — not the child's.
    expect(grandchildTurn.match(/## Conversation so far/g)).toHaveLength(1);
    expect(grandchildTurn).not.toContain("first hop");
  });

  it("leaves an image child's prompt alone", async () => {
    // The message IS the image prompt here, so a conversation prepended to it
    // would be drawn rather than read.
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"painter-img","message":"a bigger orange cat"}'),
        usageChunk(1, 1),
      ],
      [contentChunk("Here you go."), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) =>
      name === "painter-img"
        ? { ...projectFixture(), name: "painter-img", projectType: "image" }
        : null) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string) =>
      projectName === "painter-img"
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
        messages: [
          { role: "user", content: "draw a cat" },
          { role: "assistant", content: "Here is an orange cat." },
          { role: "user", content: "make it bigger" },
        ],
      }),
    );

    expect(chunks.find((c) => c.image)?.image?.prompt).toBe("a bigger orange cat");
  });
});

describe("executeAgent subagent turn budget", () => {
  it("clamps a child's maxTurn to the parent's ceiling", async () => {
    // The child continues the parent's turn counter, so a child version with a
    // larger maxTurn used to raise the limit the whole run started under.
    const childCall = (id: string) => toolCallChunk(0, id, "ping", "{}");
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_t", "transfer_to_agent", '{"agent_name":"child","message":"go"}'),
        usageChunk(1, 1),
      ],
      [childCall("c1"), usageChunk(1, 1)],
      [childCall("c2"), usageChunk(1, 1)],
      [childCall("c3"), usageChunk(1, 1)],
      [childCall("c4"), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) => ({
      ...projectFixture(),
      name,
    })) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string, versionName: string) =>
      projectName === "child" && versionName === "v1"
        ? {
            ...versionFixture({ piiFiltering: false }),
            projectName: "child",
            model: "gpt-child",
            maxTurn: 50,
          }
        : null) as ExecutionDeps["versions"]["get"];

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          subagentList: [{ name: "child", type: "local" }],
          maxTurn: 3,
        },
        messages: [{ role: "user", content: "delegate" }],
      }),
    );

    // Child starts at turn 1 and stops at the parent's ceiling of 3 — two model
    // calls. Its own maxTurn of 50 would have let it run until the scripts ran out.
    expect(channel.seenParams.filter((params) => params.model === "gpt-child")).toHaveLength(2);
  });
});

describe("executeAgent subagent recursion guards", () => {
  /** Every project is an agent that can transfer to `target`, so A -> B -> A is possible. */
  function mutualDeps(channel: FakeChannel, target: (name: string) => string) {
    const { deps, recorded } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) => ({
      ...projectFixture(),
      name,
    })) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string) => ({
      ...versionFixture({ piiFiltering: false }),
      projectName,
      subagentList: [{ name: target(projectName), type: "local" as const }],
      maxTurn: 50,
    })) as ExecutionDeps["versions"]["get"];
    return { deps, recorded };
  }

  it("refuses a transfer back to a project already on the chain", async () => {
    // painter -> child -> painter. The third hop must be rejected as a tool
    // error rather than recursing until the wall-clock deadline.
    const transferToChild = toolCallChunk(
      0,
      "call_1",
      "transfer_to_agent",
      '{"agent_name":"child","message":"go"}',
    );
    const transferToPainter = toolCallChunk(
      0,
      "call_2",
      "transfer_to_agent",
      '{"agent_name":"painter","message":"back"}',
    );
    const channel = new FakeChannel([
      [transferToChild, usageChunk(1, 1)],
      [transferToPainter, usageChunk(1, 1)],
      [contentChunk("child done"), usageChunk(1, 1)],
      [contentChunk("parent done"), usageChunk(1, 1)],
    ]);
    const { deps } = mutualDeps(channel, (name) => (name === "painter" ? "child" : "painter"));

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          subagentList: [{ name: "child", type: "local" }],
        },
        messages: [{ role: "user", content: "start" }],
      }),
    );

    const loopError = chunks.find((c) => c.error?.includes("would loop"));
    expect(loopError).toBeDefined();
    // The refusal names the transfer that was refused, and its path shows the hop
    // it came through — the middle hop no longer overwrites the author.
    expect(loopError?.author).toBe("painter");
    expect(loopError?.authorPath).toEqual(["child", "painter"]);
    expect(loopError?.error).toContain("painter -> child");
    // The run still completes normally instead of being torn down.
    expect(chunks.some((c) => c.done)).toBe(true);
  });

  it("stops a straight chain at the depth limit", async () => {
    // Each project transfers to a fresh name, so the cycle guard never fires —
    // only the depth cap can stop it.
    const transfer = (n: number) =>
      toolCallChunk(0, `call_${n}`, "transfer_to_agent", `{"agent_name":"a${n}","message":"go"}`);
    const channel = new FakeChannel([
      [transfer(1), usageChunk(1, 1)],
      [transfer(2), usageChunk(1, 1)],
      [transfer(3), usageChunk(1, 1)],
      [transfer(4), usageChunk(1, 1)],
      [transfer(5), usageChunk(1, 1)],
      [transfer(6), usageChunk(1, 1)],
      [contentChunk("deep done"), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
      [contentChunk("done"), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) => ({
      ...projectFixture(),
      name,
    })) as ExecutionDeps["projects"]["get"];
    deps.versions.get = (async (projectName: string) => {
      const depth = Number(projectName.replace("a", "")) || 0;
      return {
        ...versionFixture({ piiFiltering: false }),
        projectName,
        subagentList: [{ name: `a${depth + 1}`, type: "local" as const }],
        maxTurn: 50,
      };
    }) as ExecutionDeps["versions"]["get"];

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          subagentList: [{ name: "a1", type: "local" }],
        },
        messages: [{ role: "user", content: "start" }],
      }),
    );

    expect(chunks.some((c) => c.error?.includes("depth limit"))).toBe(true);
  });
});

describe("executeAgent remote A2A image subagent", () => {
  it("forwards returned image artifacts as authored image chunks", async () => {
    sendA2aMessageMock.mockResolvedValueOnce({
      ok: true,
      text: "",
      images: [{ b64: "aW1n", mimeType: "image/png", name: "generated.png" }],
    });
    const channel = new FakeChannel([
      [
        toolCallChunk(
          0,
          "call_t",
          "transfer_to_agent",
          '{"agent_name":"painter-a2a","message":"a watercolor cat"}',
        ),
        usageChunk(1, 1),
      ],
      [contentChunk("Here you go."), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    deps.externalAgents.get = (async (name: string) =>
      name === "painter-a2a"
        ? {
            name,
            url: "https://agents.example.com/painter",
            protocol: "a2a",
            description: "Generates images",
            headers: {},
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }
        : null) as ExecutionDeps["externalAgents"]["get"];

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: {
          ...versionFixture({ piiFiltering: false }),
          subagentList: [{ name: "painter-a2a", type: "remote" }],
        },
        messages: [{ role: "user", content: "고양이를 그려줘" }],
      }),
    );

    expect(sendA2aMessageMock).toHaveBeenCalledWith(
      "https://agents.example.com/painter",
      {},
      "a watercolor cat",
      // The run's deadline-composed signal now propagates to remote subagents.
      expect.any(AbortSignal),
    );
    expect(chunks.find((chunk) => chunk.image)).toMatchObject({
      author: "painter-a2a",
      image: {
        b64: "aW1n",
        mimeType: "image/png",
        prompt: "a watercolor cat",
      },
    });
    expect(chunks.some((chunk) => chunk.error)).toBe(false);
  });
});

describe("execution tracing policy", () => {
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

describe("executeProject non-streaming dispatch", () => {
  it("collects an agent run, images and usage included", async () => {
    const channel = new FakeChannel([[contentChunk("agent answer"), usageChunk(3, 5)]]);
    const { deps } = executionDepsFixture(channel);

    const run = await executeProject(deps, {
      project: projectFixture(),
      version: versionFixture({ piiFiltering: false }),
      messages: [{ role: "user", content: "hi" }],
    });

    expect(run.content).toBe("agent answer");
    expect(run.images).toEqual([]);
    expect(run.usage.inputTokens).toBe(3);
    expect(run.usage.outputTokens).toBe(5);
  });

  it("runs an llm project through the single-shot path", async () => {
    const channel = new FakeChannel([[contentChunk("plain answer"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const run = await executeProject(deps, {
      project: { ...projectFixture(), projectType: "llm" },
      version: versionFixture({ piiFiltering: false }),
      messages: [{ role: "user", content: "hi" }],
    });

    expect(run.content).toBe("plain answer");
    expect(run.images).toEqual([]);
  });

  it("refuses an image project instead of running it as text", async () => {
    const channel = new FakeChannel([]);
    const { deps } = executionDepsFixture(channel);
    const input = {
      project: { ...projectFixture(), projectType: "image" as const },
      version: versionFixture({ piiFiltering: false }),
      messages: [],
    };

    await expect(executeProject(deps, input)).rejects.toBeInstanceOf(ValidationError);
    expect(() => executeProjectStream(deps, input)).toThrow(ValidationError);
  });

  /**
   * A collected surface has no later frame to report a loss in, so anything the
   * run said it lost has to travel with the answer. Dropping it here is what
   * made a run that resolved half its bindings look exactly like a clean one on
   * `/predict` and `/chat/completions`.
   */
  it("carries what the run lost alongside the answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const channel = new FakeChannel([[contentChunk("answered anyway"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    deps.skills.get = (async () => null) as ExecutionDeps["skills"]["get"];
    deps.projects.get = (async () => null) as ExecutionDeps["projects"]["get"];

    const run = await executeProject(deps, {
      project: projectFixture(),
      version: {
        ...versionFixture({ piiFiltering: false }),
        skillList: ["gone-skill"],
        subagentList: [{ name: "gone-agent", type: "local" }],
      },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(run.content).toBe("answered anyway");
    expect(run.warnings).toEqual([
      expect.stringContaining("gone-skill"),
      expect.stringContaining("gone-agent"),
    ]);
    warn.mockRestore();
  });

  it("says nothing lost when the run lost nothing", async () => {
    const channel = new FakeChannel([[contentChunk("clean"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const run = await executeProject(deps, {
      project: projectFixture(),
      version: versionFixture({ piiFiltering: false }),
      messages: [{ role: "user", content: "hi" }],
    });

    expect(run.warnings).toEqual([]);
  });

  /**
   * A subagent's warning names its own agent, and what a delegation lost is the
   * caller's loss too — so it is kept, unlike an authored *termination*, which
   * speaks only for the child. The repeat is dropped: two children reporting
   * the same missing binding is one thing to tell the caller.
   */
  it("keeps an authored warning once, however many children reported it", async () => {
    const chunks: EngineChunk[] = [
      { warning: "the run lost something" },
      { author: "child", warning: "the child lost something" },
      { author: "other-child", warning: "the child lost something" },
      { delta: { content: "answer" } },
      { done: true },
    ];
    async function* source(): AsyncGenerator<EngineChunk> {
      yield* chunks;
    }

    const run = await collectRun(source(), "model");

    expect(run.warnings).toEqual(["the run lost something", "the child lost something"]);
    expect(run.content).toBe("answer");
  });

  /**
   * A streaming caller reads this sentence off the wire. Thrown untyped, the
   * collected caller got a 500 and "Internal server error" instead — the same
   * run, the same failure, and the one surface that could not say what it was.
   */
  it("throws a top-level error as an upstream failure, keeping its text", async () => {
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { error: "404 The requested resource was not found." };
    }

    const thrown = await collectRun(source(), "model").catch((error: unknown) => error);

    expect(statusForError(thrown)).toBe(502);
    expect((thrown as Error).message).toBe("404 The requested resource was not found.");
  });
});

/**
 * The other half of the same dispatch. `executeProjectStream` sends only agent
 * projects here, but three surfaces call `executeAgent` directly and one of them
 * — `/api/projects/{name}/versions/{version}/agent` — had no check of its own,
 * so it ran the tool loop on whatever project type it was handed.
 */
describe("executeAgent project type", () => {
  it("runs an agent project", async () => {
    const channel = new FakeChannel([[contentChunk("answer"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        version: versionFixture({ piiFiltering: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.some((chunk) => chunk.delta?.content === "answer")).toBe(true);
  });

  it.each(["llm", "image"] as const)("refuses a %s project before dispatching it", async (projectType) => {
    const channel = new FakeChannel([[contentChunk("should never run"), usageChunk(1, 1)]]);
    const { deps, recorded } = executionDepsFixture(channel);

    await expect(
      collect(
        executeAgent(deps, {
          project: { ...projectFixture(), projectType },
          version: versionFixture({ piiFiltering: false }),
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // The refusal has to come *before* the run, not from something downstream
    // failing: an llm project would otherwise answer from a bare system prompt
    // and succeed, and an image model would reach chat/completions.
    expect(channel.calls).toBe(0);
    expect(recorded).toEqual([]);
  });
});

/**
 * The chunk-stream entry point, for a surface that can render whatever a run
 * produces. Its image branch lived in the composition root, where nothing could
 * reach it: the webhook runner is assembled from `container.ts`, so the one
 * place the trigger path's image dispatch existed was a file the tests do not
 * construct. That is also where its `done` chunk went missing once.
 */
describe("streamProjectRun", () => {
  function imageProject(): { project: Project; version: Version } {
    return {
      project: { ...projectFixture(), projectType: "image" },
      version: {
        ...versionFixture({ piiFiltering: false }),
        model: DEFAULT_IMAGE_MODEL!,
        userPromptTemplate: "a {{animal}} in watercolour",
      },
    };
  }

  it("streams an image project as the picture, what it cost, and the ending", async () => {
    const { deps, imageModels, recorded } = executionDepsFixture(new FakeChannel([]));

    const chunks = await collect(
      streamProjectRun(deps, {
        ...imageProject(),
        messages: [{ role: "user", content: "a fox on a bicycle" }],
      }),
    );

    expect(imageModels).toEqual([DEFAULT_IMAGE_MODEL]);
    expect(chunks).toEqual([
      { image: { b64: "aW1n", mimeType: "image/png" } },
      { usage: expect.objectContaining({ inputTokens: 10, outputTokens: 100 }) },
      { done: true },
    ]);
    // Booked against the project like any other run, not silently free.
    expect(recorded).toHaveLength(1);
  });

  it("draws the newest user turn, and falls back to the version's template", async () => {
    const { deps } = executionDepsFixture(new FakeChannel([]));
    const prompts: string[] = [];
    deps.imageChannel.generateImage = (async (params: { prompt: string }) => {
      prompts.push(params.prompt);
      return {
        b64: "aW1n",
        mimeType: "image/png",
        usage: { textInputTokens: 1, imageInputTokens: 0, imageOutputTokens: 1 },
      };
    }) as ExecutionDeps["imageChannel"]["generateImage"];

    await collect(
      streamProjectRun(deps, {
        ...imageProject(),
        messages: [
          { role: "user", content: "ignore this" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "a heron" },
        ],
      }),
    );
    await collect(
      streamProjectRun(deps, {
        ...imageProject(),
        messages: [],
        variables: { animal: "otter" },
      }),
    );

    expect(prompts).toEqual([
      "You are helpful.\n\na heron",
      "You are helpful.\n\na otter in watercolour",
    ]);
  });

  it("sends every other project type down the completion path", async () => {
    const channel = new FakeChannel([[contentChunk("plain answer"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const chunks = await collect(
      streamProjectRun(deps, {
        project: { ...projectFixture(), projectType: "llm" },
        version: versionFixture({ piiFiltering: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.some((chunk) => chunk.delta?.content === "plain answer")).toBe(true);
  });
});

/**
 * What the facade carries down to whichever executor it picked.
 *
 * `caller` was declared on the facade's input, documented, and set by both
 * routes that go through it — and then dropped, because each branch rebuilt the
 * executor's input as a fresh literal and none of the four mentioned it. An
 * optional field makes that a silent drop rather than a type error, so the same
 * version named its caller on `/agent`, in a chat and in Slack (all of which
 * call `executeAgent` directly) while running anonymously on `/predict` and
 * `/chat/completions`.
 *
 * Asserted on the prompt the channel actually received, not on the input object:
 * a projection that carried the field to an executor that then ignored it would
 * pass an argument-shape test and fail the user exactly the same way.
 */
describe("executeProject dispatch carries the caller", () => {
  const CALLER = { displayName: "Bruce" };

  async function systemPromptOf(
    channel: FakeChannel,
    run: () => Promise<unknown>,
  ): Promise<string> {
    await run();
    return String(channel.seenParams[0]?.messages[0]?.content ?? "");
  }

  it.each(["agent", "llm"] as const)("through the streaming path of a %s project", async (projectType) => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const prompt = await systemPromptOf(channel, () =>
      collect(
        executeProjectStream(deps, {
          project: { ...projectFixture(), projectType },
          version: versionFixture({ piiFiltering: false, callerContext: true }),
          messages: [{ role: "user", content: "hi" }],
          caller: CALLER,
        }),
      ),
    );

    expect(prompt).toContain("You are answering Bruce.");
  });

  it.each(["agent", "llm"] as const)("through the collected path of a %s project", async (projectType) => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const prompt = await systemPromptOf(channel, () =>
      executeProject(deps, {
        project: { ...projectFixture(), projectType },
        version: versionFixture({ piiFiltering: false, callerContext: true }),
        messages: [{ role: "user", content: "hi" }],
        caller: CALLER,
      }),
    );

    expect(prompt).toContain("You are answering Bruce.");
  });

  it("still lets the version's opt-in decide, not the surface", async () => {
    // The gate belongs to `callerFor` at the engine-input boundary. Forwarding
    // the caller unconditionally is what makes that the *only* gate; a second
    // one on the way there could only ever disagree with it.
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const prompt = await systemPromptOf(channel, () =>
      collect(
        executeProjectStream(deps, {
          project: projectFixture(),
          version: versionFixture({ piiFiltering: false }),
          messages: [{ role: "user", content: "hi" }],
          caller: CALLER,
        }),
      ),
    );

    expect(prompt).not.toContain("Bruce");
  });
});
