import { withConfigurations } from "./projectConfigurations";
import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { scriptedModels } from "./scriptedModels";
import { describe, expect, it, vi } from "vitest";

import {
  collectRun,
  executeAgent,
  executeProject,
  executeProjectStream,
  streamProjectRun,
} from "@/application/execution/runProject";
import { statusForError } from "@/application/errors";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
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
import { listModels } from "@/domain/llm/models";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { LlmChannel } from "./channelFixtures";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, AgentConfiguration, AgentParameters } from "@/domain/project/types";
import type { UsageDelta } from "@/domain/usage/types";
import type { Trace } from "@/domain/trace/types";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";
import { fakeSkillRepository } from "./fakeSkills";
import { resetRunMetrics, runMetricsSnapshot } from "@/lib/runMetrics";

const DEFAULT_IMAGE_MODEL = listModels().find((m) => m.capabilities.imageGeneration)?.id;

function projectFixture(): Project {
  return {
    name: "painter",
    displayName: "Painter",
    description: "",
    ownerEmail: "owner@example.com",

    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function configurationFixture(parameters: AgentParameters): AgentConfiguration {
  return {
    projectName: "painter",

    systemPrompt: "You are helpful.",

    model: "gpt-test",
    parameters,
    mcpList: [],
    skillList: [],
    subagentList: [],
  };
}

/** Pinned so the clock line a prompt carries is deterministic. */
const TEST_NOW = new Date("2026-07-30T06:12:00Z");
function executionDepsFixture(channel: LlmChannel) {
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
    projects: withConfigurations({ get: reject, list: reject, put: reject, delete: reject }, ({ get: reject, list: reject, put: reject, delete: reject }).get),

    skills: fakeSkillRepository(reject),
    mcps: { get: reject, list: reject, put: reject, delete: reject },
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
    createToolSchemaValidator,
    channel,
    imageChannel,
    cipher: secretCipher,
    urlPolicy: testUrlPolicy,
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

describe("sampling parameters", () => {
  it("forwards presence penalties through the execution facade", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    try {
      for (const presencePenalty of [undefined, 0, 1.5]) {
        const channel = new FakeChannel([[contentChunk("Done"), usageChunk(1, 1)]]);
        const { deps } = executionDepsFixture(channel);
        await executeProject(deps, {
          project: projectFixture(),
          configuration: configurationFixture({ piiFiltering: false, presencePenalty }),
          messages: [{ role: "user", content: "Answer briefly" }],
        });
        expect(channel.seenParams[0]?.presencePenalty).toBe(presencePenalty);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

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
  it.each([false, true])("records a streamed failure even when collected=%s", async (collected) => {
    resetRunMetrics();
    const channel = new FakeChannel([]);
    channel.chatCompletionStream = async function* () {
      yield contentChunk("partial");
      throw new Error("provider disconnected");
    };
    const { deps } = executionDepsFixture(channel);
    const traces = captureTraces(deps);

    const stream = executeProjectStream(deps, {
      project: projectFixture(),
      configuration: configurationFixture({ piiFiltering: false }),
      messages: [{ role: "user", content: "hello" }],
    });
    if (collected) {
      await expect(collectRun(stream, "gpt-test")).rejects.toThrow("provider disconnected");
    } else {
      expect(await collect(stream)).toContainEqual(expect.objectContaining({ error: "provider disconnected" }));
    }
    expect(runMetricsSnapshot()).toMatchObject({ activeRuns: 0, runsFinished: 1, runsFailed: 1 });
    expect(traces.at(-1)).toMatchObject({ status: "failed", error: "provider disconnected" });
  });

  it("propagates caller cancellation to the LLM channel through the run deadline", async () => {
    const channel = new FakeChannel([[contentChunk("done"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    const abortController = new AbortController();

    await executeProject(deps, {
      messages: [{ role: "user", content: "hello" }],
      project: projectFixture(),
      configuration: configurationFixture({ piiFiltering: false }),
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

  it("records a caller-aborted Agent as cancelled", async () => {
    const controller = new AbortController();
    const responseAborted = new Error("ResponseAborted");
    const channel: LlmChannel = {
      async chatCompletion() { throw new Error("not used"); },
      async *chatCompletionStream(params) {
        controller.abort(responseAborted);
        params.signal?.throwIfAborted();
        throw responseAborted;
      },
    };
    const { deps } = executionDepsFixture(channel);
    deps.channel = scriptedModels(channel);

    const traces = captureTraces(deps);

    await expect(
      executeProject(deps, {
      messages: [{ role: "user", content: "hello" }],
        project: { ...projectFixture() },
        configuration: configurationFixture({ piiFiltering: false }),
        signal: controller.signal,
      }),
    ).rejects.toThrow("ResponseAborted");

    expect(traces[0]?.status).toBe("cancelled");
    expect(traces[0]?.error).toBeUndefined();
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
        configuration: configurationFixture({ piiFiltering: false, imageGeneration: true }),
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
        configuration: configurationFixture({ piiFiltering: false }),
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
        configuration: configurationFixture({ piiFiltering: false, imageGeneration: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(offersImageTool(channel)).toBe(false);
  });

  it("uses the version's imageModel and records usage against it", async () => {
    const channel = new FakeChannel(imageCallScript);
    const { deps, recorded, imageModels } = executionDepsFixture(channel);
    const traces = captureTraces(deps);
    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: configurationFixture({
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
    const imageUsage = recorded.find((record) => record.model === "google/gemini-3-pro-image")!;
    expect(chunks.filter((chunk) => chunk.usage?.model === imageUsage.model)).toEqual([
      expect.objectContaining({ usage: { model: imageUsage.model, inputTokens: imageUsage.inputTokens, outputTokens: imageUsage.outputTokens, costUsd: imageUsage.costUsd } }),
    ]);
    expect(imageUsage.calls).toBe(1);
    expect(traces[0]?.spans.filter((span) => span.kind === "model" && span.name === imageUsage.model)).toEqual([
      expect.objectContaining({ parentSpanId: expect.any(String), input: { inputTokens: imageUsage.inputTokens }, output: expect.objectContaining({ outputTokens: imageUsage.outputTokens, costUsd: imageUsage.costUsd }) }),
    ]);
  });

  it("falls back to the default image model when imageModel is unset", async () => {
    const channel = new FakeChannel(imageCallScript);
    const { deps, imageModels } = executionDepsFixture(channel);
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: configurationFixture({ piiFiltering: false, imageGeneration: true }),
        messages: [{ role: "user", content: "draw a fox" }],
      }),
    );
    expect(imageModels).toEqual([DEFAULT_IMAGE_MODEL]);
  });

  it("marks a failed image request as an error span without inventing usage", async () => {
    const { deps, recorded } = executionDepsFixture(new FakeChannel(imageCallScript));
    const traces = captureTraces(deps);
    deps.imageChannel.generateImage = async () => { throw new Error("image provider failed"); };
    const chunks = await collect(executeAgent(deps, {
      project: projectFixture(),
      configuration: configurationFixture({ piiFiltering: false, imageGeneration: true }),
      messages: [{ role: "user", content: "draw a fox" }],
    }));
    expect(recorded.some((record) => record.model === DEFAULT_IMAGE_MODEL)).toBe(false);
    expect(chunks.some((chunk) => chunk.usage?.model === DEFAULT_IMAGE_MODEL)).toBe(false);
    const imageTool = traces[0]!.spans.find((span) => span.kind === "tool" && span.name === "GenerateImage")!;
    expect(imageTool.status).toBe("error");
    const request = traces[0]!.spans.find((span) => span.kind === "model" && span.parentSpanId === imageTool.spanId)!;
    expect(request.status).toBe("error");
    expect(request.output).not.toHaveProperty("costUsd");
  });

  it("falls back to the default image model when the stored imageModel left the registry", async () => {
    const channel = new FakeChannel(imageCallScript);
    const { deps, imageModels } = executionDepsFixture(channel);
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: configurationFixture({
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
    // What `resolveImageModel` is for. The two builders would compute this
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
        configuration: configurationFixture({
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
  const visionVersion = (parameters: AgentParameters): AgentConfiguration => ({
    ...configurationFixture(parameters),
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
    const traces = captureTraces(deps);

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: visionVersion({ piiFiltering: false, imageGeneration: true }),
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
    expect(chunks.filter((chunk) => chunk.usage?.model === DEFAULT_IMAGE_MODEL)).toEqual([
      expect.objectContaining({ usage: { model: DEFAULT_IMAGE_MODEL, inputTokens: 25, outputTokens: 60, costUsd: editUsage!.costUsd } }),
    ]);
    expect(editUsage?.calls).toBe(1);
    expect(traces[0]?.spans.filter((span) => span.kind === "model" && span.name === DEFAULT_IMAGE_MODEL)).toEqual([
      expect.objectContaining({ input: { inputTokens: 25 }, output: expect.objectContaining({ outputTokens: 60, costUsd: editUsage!.costUsd }) }),
    ]);
  });

  it("lists the attached image in the system prompt so the model can name it", async () => {
    const channel = new FakeChannel(editScript);
    const { deps } = executionDepsFixture(channel);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: visionVersion({ piiFiltering: false, imageGeneration: true }),
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: ATTACHED } }] },
        ],
      }),
    );

    const systemPrompt = String(channel.seenParams[0]?.messages[0]?.content);
    expect(systemPrompt).toContain("## Available Images");
    expect(systemPrompt).toContain("| img_1 | from the conversation |");
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
        configuration: visionVersion({ piiFiltering: false, imageGeneration: true }),
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
        configuration: visionVersion({ piiFiltering: false, imageGeneration: false }),
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
        configuration: visionVersion({ piiFiltering: false, imageGeneration: true }),
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
    };
    const childVersion: AgentConfiguration = {
      ...configurationFixture({ piiFiltering: false }),
      projectName: "simple-image",
      model: "google/gemini-2.5-flash",
      parameters: { piiFiltering: false, imageGeneration: true, imageModel: DEFAULT_IMAGE_MODEL },
    };
    const deps = {
      ...fixture.deps,
      projects: withConfigurations({ get: async (name: string) => (name === "simple-image" ? child : parent) }, ({
        get: async (project: string) => (project === "simple-image" ? childVersion : null),
        list: async () => [childVersion],
      }).get),

    } as unknown as ExecutionDeps;
    return { ...fixture, deps, parent };
  }

  const transferScript = (args: string) => {
    const request = JSON.parse(args);
    const images: string[] = request.image_ids ?? [];
    const imageTask = request.agent_name === "simple-image" && images.every(id => id === "img_1");
    return [
      [toolCallChunk(0, "call_t", `delegate_${request.agent_name}`, JSON.stringify({ input: request.message, image_ids: images })), usageChunk(1, 1)],
      ...(imageTask ? [
        [toolCallChunk(0, "image", images.length ? "EditImage" : "GenerateImage", JSON.stringify({ prompt: request.message, ...(images.length ? { image_id: "img_1" } : {}) })), usageChunk(1, 1)],
        [contentChunk("Image ready."), usageChunk(1, 1)],
      ] : []),
      [contentChunk("Done — the image is updated."), usageChunk(1, 1)],
    ];
  };

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
          configuration: configurationFixture({ piiFiltering: false }),
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
        configuration: parentVersion(),
        messages: [{ role: "user", content: "draw a fox" }],
      }),
    );

    expect(claims).toEqual([{ project: "simple-image", kind: "alert" }]);
  });

  function parentVersion(): AgentConfiguration {
    return {
      ...configurationFixture({ piiFiltering: false }),
      model: "google/gemini-2.5-flash",
      subagentList: [{ name: "simple-image" }],
    };
  }

  it("cancels a delegated image tool with its parent run", async () => {
    const controller = new AbortController();
    const fixture = imageProjectDeps(new FakeChannel(transferScript('{"agent_name":"simple-image","message":"draw a fox"}')));
    const traces = captureTraces(fixture.deps);
    const generate = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      controller.abort(new Error("image cancelled"));
      signal?.throwIfAborted();
      throw new Error("Image call should have been cancelled");
    });
    fixture.deps.imageChannel.generateImage = generate;
    await expect(collect(executeAgent(fixture.deps, {
      project: fixture.parent, configuration: parentVersion(), signal: controller.signal,
      messages: [{ role: "user", content: "draw a fox" }],
    }))).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(traces).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });

  it("hands the named image to an image subagent, which edits instead of drawing", async () => {
    const channel = new FakeChannel(
      transferScript('{"agent_name":"simple-image","message":"make it blue","image_ids":["img_1"]}'),
    );
    const { deps, edits, imageModels, parent } = imageProjectDeps(channel);

    const chunks = await collect(
      executeAgent(deps, {
        project: parent,
        configuration: parentVersion(),
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
        prompt: "make it blue",
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
        configuration: parentVersion(),
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
        configuration: parentVersion(),
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: ATTACHED } }] },
        ],
      }),
    );

    expect(edits).toEqual([]);
    expect(imageModels).toEqual([]);
    const result = chunks.find((c) => c.toolResult?.name === "delegate_simple-image: simple-image")?.toolResult;
    expect(result?.content).toContain("Unknown image 'img_7'");
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
    const childVersion: AgentConfiguration = {
      ...configurationFixture({ piiFiltering: false }),
      projectName: "text-child",
      // Not in the model registry, so image input is rejected.
      model: "gpt-test",
    };
    const deps = {
      ...fixture.deps,
      projects: withConfigurations({ get: async (name: string) => ({ ...projectFixture(), name }) }, ({ get: async () => childVersion, list: async () => [childVersion] }).get),

    } as unknown as ExecutionDeps;

    const chunks = await collect(
      executeAgent(deps, {
        project: { ...projectFixture(), name: "sample-agent" },
        configuration: { ...parentVersion(), subagentList: [{ name: "text-child" }] },
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: ATTACHED } }] },
        ],
      }),
    );

    const failure = chunks.find((c) => c.toolResult?.content.startsWith("Error:"));
    expect(failure?.toolResult?.content).toContain("text-child");
    expect(failure?.toolResult?.content).toContain("image input");
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
        configuration: parentVersion(),
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: ATTACHED } }] },
        ],
      }),
    );

    const transfer = channel.seenParams[0]?.tools?.find(
      (t) => t.function.name === "delegate_simple-image",
    );
    const properties = transfer?.function.parameters?.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("image_ids");
    const systemPrompt = String(channel.seenParams[0]?.messages[0]?.content);
    expect(systemPrompt).toContain("## Available Images");
    expect(systemPrompt).toContain("| img_1 | from the conversation |");
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
        configuration: parentVersion(),
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
        configuration: { ...parentVersion(), parameters: { piiFiltering: false, imageGeneration: true } },
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
      },
    };
    const versions: Record<string, AgentConfiguration> = {
      "bruce-bot": {
        ...configurationFixture({ piiFiltering: false }),
        projectName: "bruce-bot",
        model: "google/gemini-2.5-flash",
        subagentList: [{ name: "sample-agent" }],
      },
      "sample-agent": {
        ...configurationFixture({ piiFiltering: false }),
        projectName: "sample-agent",
        model: "google/gemini-2.5-flash",
        subagentList: [{ name: "simple-image" }],
      },
      "simple-image": {
        ...configurationFixture({ piiFiltering: false }),
        projectName: "simple-image",
        model: "google/gemini-2.5-flash",
      parameters: { piiFiltering: false, imageGeneration: true, imageModel: DEFAULT_IMAGE_MODEL },
      },
    };
    const traces: Trace[] = [];
    const deps = {
      ...fixture.deps,
      projects: withConfigurations({ get: async (name: string) => projects[name] ?? null }, ({ get: async (project: string) => versions[project] ?? null, list: async () => [] }).get),

      traces: { put: async (trace: Trace) => void traces.push(trace) },
    } as unknown as ExecutionDeps;
    return { deps, traces, top: projects["bruce-bot"] as Project, configuration: versions["bruce-bot"] as AgentConfiguration };
  }

  const chainScript = [
    // bruce-bot hands off…
    [
      toolCallChunk(0, "t1", "delegate_sample-agent", "{\"input\":\"draw\",\"image_ids\":[]}"),
      usageChunk(1, 1),
    ],
    // …sample-agent hands off again…
    [
      toolCallChunk(0, "t2", "handoff_simple-image", "{\"input\":\"a fox\",\"image_ids\":[]}"),
      usageChunk(2, 2),
    ],
    [toolCallChunk(0, "image", "GenerateImage", '{"prompt":"a fox"}'), usageChunk(1, 1)],
    // The handed-off Agent finishes the delegated run, then the parent answers.
    [contentChunk("passing it up"), usageChunk(3, 3)],
    [contentChunk("here is your fox"), usageChunk(4, 4)],
  ];

  it("keeps a handoff within the delegated output scope", async () => {
    const channel = new FakeChannel(chainScript);
    const { deps, top, configuration } = chainDeps(channel);

    const chunks = await collect(executeAgent(deps, { project: top, configuration, messages: [{ role: "user", content: "draw a fox" }] }));

    // Handoff changes the active Agent inside the same delegated Runner.
    const imageChunk = chunks.find((c) => c.image);
    expect(imageChunk?.author).toBe("sample-agent");
    expect(imageChunk?.authorPath).toEqual(["sample-agent"]);
    const imageUsage = chunks.find((chunk) => chunk.usage?.model === DEFAULT_IMAGE_MODEL);
    expect(imageUsage?.author).toBe(imageChunk?.author);
    expect(imageUsage?.authorPath).toEqual(imageChunk?.authorPath);
    expect(imageUsage?.transferId).toBe(imageChunk?.transferId);
    // The middle hop still reports itself for its own output.
    const middle = chunks.find((c) => c.author === "sample-agent" && c.delta?.content);
    expect(middle?.authorPath).toEqual(["sample-agent"]);
    // Top-level answer stays unauthored, so the visible answer is unchanged.
    const answer = chunks.filter((c) => c.author === undefined && c.delta?.content);
    expect(answer.map((c) => c.delta?.content).join("")).toBe("here is your fox");
  });

  it("records native nested agents and action tools in one trace hierarchy", async () => {
    const channel = new FakeChannel(chainScript);
    const { deps, traces, top, configuration } = chainDeps(channel);

    await collect(executeAgent(deps, { project: top, configuration, messages: [{ role: "user", content: "draw a fox" }] }));

    // Agent handoffs and image tools stay in the parent Trace hierarchy.
    expect(traces.map((trace) => trace.projectName).sort()).toEqual(["bruce-bot"]);
    const spans = traces.find((trace) => trace.projectName === "bruce-bot")!.spans;
    const child = spans.find((span) => span.kind === "subagent" && span.name === "simple-image");
    const action = spans.find((span) => span.kind === "tool" && span.name === "GenerateImage");
    expect(child?.parentSpanId).toBeDefined();
    expect(action?.parentSpanId).toBeDefined();
    const imageModel = spans.find((span) => span.kind === "model" && span.name === DEFAULT_IMAGE_MODEL);
    expect(imageModel?.parentSpanId).toBe(action?.spanId);
    expect(imageModel?.output?.outputTokens).toBe(100);
    const ancestors = new Set<string>();
    let current = action;
    while (current?.parentSpanId) {
      ancestors.add(current.parentSpanId);
      current = spans.find((span) => span.spanId === current?.parentSpanId);
    }
    expect(ancestors.has(child!.spanId)).toBe(true);
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
    ...configurationFixture({ piiFiltering: false }),
    skillList: ["alive", "deleted"],
  });

  it("does not offer a skill whose registry entry is gone, and describes without reading a body", async () => {
    // A deleted skill would be advertised with an empty description and then
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
        configuration: boundToTwoSkills(),
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
        configuration: boundToTwoSkills(),
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
    deps.projects = withConfigurations(deps.projects, async () => ({ ...configurationFixture({ piiFiltering: false }), projectName: "alive-agent" })) as ExecutionDeps["projects"];

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: {
          ...configurationFixture({ piiFiltering: false }),
          subagentList: [
            { name: "alive-agent" },
            { name: "deleted-agent" },
          ],
        },
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const names = channel.seenParams[0]?.tools?.map((entry) => entry.function.name);
    expect(names).toContain("delegate_alive-agent");
    expect(names).not.toContain("delegate_deleted-agent");
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
        configuration: {
          ...configurationFixture({ piiFiltering: false }),
          skillList: ["gone-skill"],
          subagentList: [{ name: "gone-agent" }],
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
        configuration: {
          ...configurationFixture({ piiFiltering: false }),
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
        configuration: { ...configurationFixture({ piiFiltering: false }), skillList: ["here"] },
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.some((chunk) => chunk.warning)).toBe(false);
  });
});

describe("executeAgent PII filtering", () => {
  it.each([true, false])("passes piiFiltering=%s to the engine", async (piiFiltering) => {
    const channel = new FakeChannel([[contentChunk("Contact the masked value."), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: configurationFixture({ piiFiltering }),
        messages: [{ role: "user", content: "email@example.com or 010-1234-5678" }],
      }),
    );

    const user = channel.seenParams[0]?.messages.find((message) => message.role === "user");
    expect(user).toBeDefined();
    const sent = String(user?.content);
    if (piiFiltering) {
      expect(sent).toContain("[[PII:");
      expect(sent).not.toContain("email@example.com");
      expect(sent).not.toContain("010-1234-5678");
    } else {
      expect(sent).toBe("email@example.com or 010-1234-5678");
    }
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
          configuration: { ...configurationFixture({ piiFiltering: false }), mcpList: [{ name: "internal-mcp" }] },
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

describe("executeAgent local subagent dispatch", () => {

  it("pins the clock for the whole run, so a child cannot say a different now", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(
          0,
          "call_t",
          "delegate_summarizer",
          "{\"input\":\"three otters\",\"image_ids\":[]}",
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
        ? { ...projectFixture(), name: "summarizer" }
        : null) as ExecutionDeps["projects"]["get"];
    deps.projects = withConfigurations(deps.projects, async (projectName: string) =>
      projectName === "summarizer"
        ? {
            ...configurationFixture({ piiFiltering: false }),
            projectName: "summarizer",
            systemPrompt: "You summarize.",
            userPromptTemplate: "Answer in exactly one sentence.",
          }
        : null) as ExecutionDeps["projects"];

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: {
          ...configurationFixture({ piiFiltering: false }),
          subagentList: [{ name: "summarizer" }],
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
    deps.projects = withConfigurations(deps.projects, async (projectName: string) =>
      projectName === "child"
        ? { ...configurationFixture({ piiFiltering: false }), projectName: "child" }
        : null) as ExecutionDeps["projects"];
    return { deps, ...rest };
  }

  const transferThenAnswer = (message: string) => [
    [
      toolCallChunk(0, "call_t", "delegate_child", JSON.stringify({ input: message, image_ids: [] })),
      usageChunk(1, 1),
    ],
    [contentChunk("Child answer."), usageChunk(1, 1)],
    [contentChunk("Passed on."), usageChunk(1, 1)],
  ];

  function parentVersion() {
    return {
      ...configurationFixture({ piiFiltering: false }),
      subagentList: [{ name: "child" }],
    };
  }

  it("carries the earlier turns a follow-up refers to", async () => {
    // "make it bigger" is meaningless to an agent that never saw what was made.
    const channel = new FakeChannel(transferThenAnswer("make it bigger"));
    const { deps } = chainDeps(channel);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: parentVersion(),
        messages: [
          { role: "user", content: "draw a cat" },
          { role: "assistant", content: "Here is an orange cat." },
          { role: "user", content: "make it bigger" },
        ],
      }),
    );

    const childTurn = String(channel.seenParams[1]?.messages.at(-1)?.content);
    expect(childTurn).toContain("Conversation context:");
    expect(childTurn).toContain("User: draw a cat");
    // The parent's own turns are labelled with the parent, so the child can
    // tell whose answers these were instead of reading them as its own.
    expect(childTurn).toContain(`${projectFixture().name}: Here is an orange cat.`);
    expect(childTurn).toContain("Request:\nmake it bigger");
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
    deps.projects = withConfigurations(deps.projects, async (projectName: string) =>
      projectName === "child"
        ? {
            ...configurationFixture({ piiFiltering: false }),
            projectName: "child",
            skillList: ["unreadable"],
          }
        : null) as ExecutionDeps["projects"];
    const traces = captureTraces(deps);

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: parentVersion(),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.some((chunk) => chunk.toolResult?.content.startsWith("Error:"))).toBe(true);
    expect(traces[0]?.status).toBe("completed");
    expect(traces[0]?.spans.find((span) => span.name === "delegate_child")?.status).toBe("error");
  });

  it("sends a first-turn transfer exactly as before, with no context block", async () => {
    // A conversation of one turn has no "so far" — framing one would be noise.
    const channel = new FakeChannel(transferThenAnswer("draw a cat"));
    const { deps } = chainDeps(channel);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: parentVersion(),
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
        toolCallChunk(0, "t1", "delegate_child", "{\"input\":\"first hop\",\"image_ids\":[]}"),
        usageChunk(1, 1),
      ],
      [
        toolCallChunk(0, "t2", "handoff_child2", "{\"input\":\"second hop\",\"image_ids\":[]}"),
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
    deps.projects = withConfigurations(deps.projects, async (projectName: string) =>
      projectName === "child"
        ? {
            ...configurationFixture({ piiFiltering: false }),
            projectName: "child",
            subagentList: [{ name: "child2" }],
          }
        : projectName === "child2"
          ? { ...configurationFixture({ piiFiltering: false }), projectName: "child2" }
          : null) as ExecutionDeps["projects"];

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: parentVersion(),
        messages: [
          { role: "user", content: "draw a cat" },
          { role: "assistant", content: "Here is an orange cat." },
          { role: "user", content: "make it bigger" },
        ],
      }),
    );

    const grandchildMessages = channel.seenParams[2]?.messages;
    const context = JSON.stringify(grandchildMessages);
    expect(context).toContain("User: draw a cat");
    expect(grandchildMessages?.at(-1)?.content).toBe("second hop");
    // Native handoff preserves the existing conversation in the same Runner.
    expect(context.match(/Conversation context:/g)).toHaveLength(1);
  });

});

describe("executeAgent subagent turn budget", () => {
  it("clamps a child's maxTurn to the parent's ceiling", async () => {
    // The child continues the parent's turn counter, so a child version with a
    // larger maxTurn would raise the limit the whole run started under.
    const childCall = (id: string) => toolCallChunk(0, id, "GenerateImage", '{"prompt":"fox"}');
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_t", "delegate_child", "{\"input\":\"go\",\"image_ids\":[]}"),
        usageChunk(1, 1),
      ],
      [childCall("c1"), usageChunk(1, 1)],
      [contentChunk("partial findings"), usageChunk(1, 1)],
      [contentChunk("parent recovered"), usageChunk(1, 1)],
    ]);
    const { deps } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) => ({
      ...projectFixture(),
      name,
    })) as ExecutionDeps["projects"]["get"];
    deps.projects = withConfigurations(deps.projects, async (projectName: string) =>
      projectName === "child"
        ? {
            ...configurationFixture({ piiFiltering: false }),
            projectName: "child",
            model: "gpt-child",
            parameters: { piiFiltering: false, imageGeneration: true },
            maxTurn: 50,
          }
        : null) as ExecutionDeps["projects"];

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: {
          ...configurationFixture({ piiFiltering: false }),
          subagentList: [{ name: "child" }],
          maxTurn: 3,
        },
        messages: [{ role: "user", content: "delegate" }],
      }),
    );

    // Child starts at turn 1 and stops at the parent's ceiling of 3 — two model
    // calls. Its own maxTurn of 50 would have let it run until the scripts ran out.
    expect(channel.seenParams.filter((params) => params.model === "gpt-child")).toHaveLength(2);
    expect(chunks.some((chunk) => chunk.author === "child" && chunk.warning?.includes("turn limit (2 turns)"))).toBe(true);
    expect(chunks.filter((chunk) => !chunk.author && chunk.delta?.content).map((chunk) => chunk.delta?.content).join("")).toBe("parent recovered");
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
    deps.projects = withConfigurations(deps.projects, async (projectName: string) => ({
      ...configurationFixture({ piiFiltering: false }),
      projectName,
      subagentList: [{ name: target(projectName) }],
      maxTurn: 50,
    })) as ExecutionDeps["projects"];
    return { deps, recorded };
  }

  it("refuses a transfer back to a project already on the chain", async () => {
    // painter -> child -> painter. The third hop must be rejected as a tool
    // error rather than recursing until the wall-clock deadline.
    const transferToChild = toolCallChunk(
      0,
      "call_1",
      "delegate_child",
      "{\"input\":\"go\",\"image_ids\":[]}",
    );
    const transferToPainter = toolCallChunk(
      0,
      "call_2",
      "handoff_painter",
      "{\"input\":\"back\",\"image_ids\":[]}",
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
        configuration: {
          ...configurationFixture({ piiFiltering: false }),
          subagentList: [{ name: "child" }],
        },
        messages: [{ role: "user", content: "start" }],
      }),
    );

    const loopError = chunks.find((c) => c.warning?.includes("cycle"));
    expect(loopError).toBeDefined();
    expect(loopError?.warning).toContain("painter");
    // The run still completes normally instead of being torn down.
    expect(chunks.some((c) => c.done)).toBe(true);
  });

  it("stops a straight chain at the depth limit", async () => {
    // Each project transfers to a fresh name, so the cycle guard never fires —
    // only the depth cap can stop it.
    const transfer = (n: number) =>
      toolCallChunk(0, `call_${n}`, n === 1 ? `delegate_a${n}` : `handoff_a${n}`, JSON.stringify({ input: "go", image_ids: [] }));
    const channel = new FakeChannel([
      [transfer(1), usageChunk(1, 1)],
      [transfer(2), usageChunk(1, 1)],
      [transfer(3), usageChunk(1, 1)],
      [transfer(4), usageChunk(1, 1)],
      [transfer(5), usageChunk(1, 1)],
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
    deps.projects = withConfigurations(deps.projects, async (projectName: string) => {
      const depth = Number(projectName.replace("a", "")) || 0;
      return {
        ...configurationFixture({ piiFiltering: false }),
        projectName,
        subagentList: [{ name: `a${depth + 1}` }],
        maxTurn: 50,
      };
    }) as ExecutionDeps["projects"];

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: {
          ...configurationFixture({ piiFiltering: false }),
          subagentList: [{ name: "a1" }],
        },
        messages: [{ role: "user", content: "start" }],
      }),
    );

    expect(chunks.some((c) => c.warning?.includes("depth limit"))).toBe(true);
  });
});

describe("execution tracing policy", () => {
  it("always traces agent runs", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const traces = captureTraces(deps);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: configurationFixture({ piiFiltering: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(traces).toHaveLength(1);
    expect(traces[0]?.spans.some((span) => span.kind === "model")).toBe(true);
  });

  it("stamps the run's own traceId on its top-level chunks", async () => {
    // The one place a consumer can join "this run" to "its trace" from the
    // stream alone — the trigger firing row does exactly that. A child's
    // chunks carry the child's trace, so without this the first authored
    // chunk's id was the only candidate, and it was the wrong trace.
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    const traces = captureTraces(deps);

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: configurationFixture({ piiFiltering: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const topLevel = chunks.filter((chunk) => chunk.author === undefined);
    expect(topLevel.length).toBeGreaterThan(0);
    expect(topLevel.every((chunk) => chunk.traceId === traces[0]?.traceId)).toBe(true);
  });

  it("stamps the shared facade traceId on its top-level chunks", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    deps.channel = scriptedModels(channel);

    const traces = captureTraces(deps);

    const chunks = await collect(
      executeProjectStream(deps, {
        project: { ...projectFixture() },
        configuration: configurationFixture({ piiFiltering: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(traces).toHaveLength(1);
    expect(chunks.every((chunk) => chunk.traceId === traces[0]?.traceId)).toBe(true);
  });

  it("records what the run did before its first model call, through the run itself", async () => {
    // The recorder's own arithmetic is covered in tests/trace.test.ts; what is
    // covered here is the wiring — that a real run emits the stage at all, and
    // that the span says what the resolve came back with.
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    const traces = captureTraces(deps);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: configurationFixture({ piiFiltering: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const prepare = traces[0]?.spans.filter((span) => span.kind === "prepare" && !span.output?.sdkType) ?? [];
    expect(prepare.map((span) => span.name)).toEqual(["tools"]);
    expect(prepare[0]?.status).toBe("ok");
    expect(prepare[0]?.output).toMatchObject({ skills: 0, subagents: 0, mcpServers: 0, mcpTools: 0 });
  });

  it("records the memory stage only for a version that asked for one", async () => {
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);
    const traces = captureTraces(deps);

    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: configurationFixture({ piiFiltering: false, memoryRecall: true }),
        messages: [{ role: "user", content: "what did we decide?" }],
      }),
    );

    const memory = traces[0]?.spans.find((span) => span.name === "memory");
    expect(memory?.kind).toBe("prepare");
    // No bound server offers `recall`, which is a misconfiguration this version
    // will warn about on every run it makes — not a stage that failed, and the
    // difference is what keeps a red span meaning something.
    expect(memory?.status).toBe("ok");
    expect(memory?.output).toMatchObject({ asked: 0, warnings: 1 });
  });

});

describe("executeProject non-streaming dispatch", () => {
  it("collects image generation and editing usage exactly once with text usage", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "generate", "GenerateImage", '{"prompt":"a fox"}'), usageChunk(1, 2)],
      [toolCallChunk(0, "edit", "EditImage", '{"image_id":"img_1","prompt":"at night"}'), usageChunk(3, 4)],
      [contentChunk("done"), usageChunk(5, 6)],
    ]);
    const { deps, recorded } = executionDepsFixture(channel);
    const traces = captureTraces(deps);
    const run = await executeProject(deps, {
      project: projectFixture(),
      configuration: configurationFixture({ piiFiltering: false, imageGeneration: true }),
      messages: [{ role: "user", content: "draw a fox and make it night" }],
    });
    const totals = recorded.reduce((total, record) => ({
      inputTokens: total.inputTokens + record.inputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      costUsd: total.costUsd + record.costUsd,
    }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(run.images).toHaveLength(2);
    expect(run.images.every((image) => !("usage" in image))).toBe(true);
    expect(run.usage).toEqual(totals);
    expect(run.usage.inputTokens).toBe(44);
    expect(run.usage.outputTokens).toBe(172);
    expect(recorded.find((record) => record.model === DEFAULT_IMAGE_MODEL)?.calls).toBe(2);
    const modelSpans = traces[0]!.spans.filter((span) => span.kind === "model");
    expect(modelSpans.reduce((cost, span) => cost + Number(span.output?.costUsd ?? 0), 0)).toBeCloseTo(totals.costUsd, 10);
  });

  it("collects an agent run, images and usage included", async () => {
    const channel = new FakeChannel([[contentChunk("agent answer"), usageChunk(3, 5)]]);
    const { deps } = executionDepsFixture(channel);

    const run = await executeProject(deps, {
      project: projectFixture(),
      configuration: configurationFixture({ piiFiltering: false }),
      messages: [{ role: "user", content: "hi" }],
    });

    expect(run.content).toBe("agent answer");
    expect(run.images).toEqual([]);
    expect(run.usage.inputTokens).toBe(3);
    expect(run.usage.outputTokens).toBe(5);
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
      configuration: {
        ...configurationFixture({ piiFiltering: false }),
        skillList: ["gone-skill"],
        subagentList: [{ name: "gone-agent" }],
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
      configuration: configurationFixture({ piiFiltering: false }),
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
   * `/predict` answers from here for an agent project and from `toUsageInfo`
   * for an `llm` one. Built field by field, this accumulator dropped both
   * subset fields, so the same endpoint reported them for one project type and
   * not the other — indistinguishable, to a caller, from a provider that never
   * reported them at all.
   */
  it("carries the usage fields that are subsets of the two totals", async () => {
    async function* source(): AsyncGenerator<EngineChunk> {
      yield {
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 1, cachedTokens: 4, reasoningTokens: 7 },
      };
      yield { usage: { inputTokens: 5, outputTokens: 6, costUsd: 1, reasoningTokens: 3 } };
      yield { delta: { content: "answer" } };
      yield { done: true };
    }

    const run = await collectRun(source(), "model");

    expect(run.usage).toEqual({
      inputTokens: 15,
      outputTokens: 26,
      costUsd: 2,
      cachedTokens: 4,
      reasoningTokens: 10,
    });
  });

  it("leaves both off when nothing reported them", async () => {
    // Absent, not zero: a channel that never reports one must stay tellable
    // from one reporting a cold cache or a model that did not think.
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { usage: { inputTokens: 1, outputTokens: 2, costUsd: 3 } };
      yield { done: true };
    }

    const run = await collectRun(source(), "model");

    expect(run.usage).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: 3 });
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

/** Direct execution uses the Agent loop. */
describe("executeAgent", () => {
  it("runs a configured Agent", async () => {
    const channel = new FakeChannel([[contentChunk("answer"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const chunks = await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: configurationFixture({ piiFiltering: false }),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chunks.some((chunk) => chunk.delta?.content === "answer")).toBe(true);
  });

});

describe("executeAgent retrieval usage", () => {
  it("flushes rerank calls through the run usage aggregator", async () => {
    const channel = new FakeChannel([[contentChunk("done"), usageChunk(1, 1)]]);
    const { deps, recorded } = executionDepsFixture(channel);
    deps.skills = {
      ...deps.skills,
      describe: async (names) => names.map((name) => ({ name, description: "Search AWS documentation" })),
    };
    deps.catalog = {
      embeddings: { embed: async (texts) => texts.map(() => [1]) },
      catalog: {
        upsert: async () => {},
        deleteByKeys: async () => {},
        listKeys: async () => [],
        query: async (_vector, _topK, filter) =>
          filter?.kind === "skill"
            ? [{
                key: "skill#aws-knowledge",
                score: 0.9,
                metadata: { name: "aws-knowledge", description: "Search AWS documentation" },
              }]
            : [],
      },
      reranker: {
        rerank: async () => ({
          scores: [0.9],
          usage: { model: "openrouter/rerank-v3.5", inputTokens: 21, costUsd: 0.001 },
        }),
      },
    };

    await collect(executeAgent(deps, {
      project: projectFixture(),
      configuration: configurationFixture({ piiFiltering: false, dynamicCapabilities: true }),
      messages: [{ role: "user", content: "find the AWS docs" }],
    }));

    expect(recorded).toContainEqual({
      projectName: "painter",
      date: expect.any(String),
      model: "openrouter/rerank-v3.5",
      calls: 1,
      inputTokens: 21,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0.001,
    });
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
  it("streams Agent text, image output, usage and completion through one facade", async () => {
    const channel = new FakeChannel(imageCallScript);
    const { deps, imageModels, recorded } = executionDepsFixture(channel);
    const chunks = await collect(streamProjectRun(deps, {
      project: projectFixture(), configuration: configurationFixture({ piiFiltering: false, imageGeneration: true }),
      messages: [{ role: "user", content: "Draw a red fox" }],
    }));
    expect(imageModels).toEqual([DEFAULT_IMAGE_MODEL]);
    expect(chunks.some(chunk => chunk.image?.mimeType === "image/png")).toBe(true);
    expect(chunks.some(chunk => chunk.delta?.content)).toBe(true);
    expect(chunks.some(chunk => chunk.usage)).toBe(true);
    expect(chunks.some(chunk => chunk.done)).toBe(true);
    expect(recorded.some(record => record.model === DEFAULT_IMAGE_MODEL)).toBe(true);
  });
});

describe("executeProject dispatch carries the caller", () => {
  const CALLER = { displayName: "Bruce" };

  async function systemPromptOf(
    channel: FakeChannel,
    run: () => Promise<unknown>,
  ): Promise<string> {
    await run();
    return String(channel.seenParams[0]?.messages[0]?.content ?? "");
  }

  it("through the streaming path", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const prompt = await systemPromptOf(channel, () =>
      collect(
        executeProjectStream(deps, {
          project: projectFixture(),
          configuration: configurationFixture({ piiFiltering: false, callerContext: true }),
          messages: [{ role: "user", content: "hi" }],
          caller: CALLER,
        }),
      ),
    );

    expect(prompt).toContain("You are answering Bruce.");
  });

  it("through the collected path", async () => {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const { deps } = executionDepsFixture(channel);

    const prompt = await systemPromptOf(channel, () =>
      executeProject(deps, {
        project: projectFixture(),
        configuration: configurationFixture({ piiFiltering: false, callerContext: true }),
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
          configuration: configurationFixture({ piiFiltering: false }),
          messages: [{ role: "user", content: "hi" }],
          caller: CALLER,
        }),
      ),
    );

    expect(prompt).not.toContain("Bruce");
  });
});

/**
 * A transfer is not a second person's request — `RunOrigin` has said the caller
 * travels the chain since it was written. Nothing populated or read the field,
 * so a child version that had asked to be told who is asking ran anonymously:
 * the checkbox on, the block missing, and nothing anywhere saying so.
 */
describe("a transfer carries who is asking", () => {
  const CALLER = { displayName: "Bruce", timezone: "Asia/Seoul" };

  /** A parent that transfers to `child`, whose version this test decides. */
  function transferDeps(
    channel: FakeChannel,
    childParameters: AgentParameters,
  ) {
    const { deps } = executionDepsFixture(channel);
    deps.projects.get = (async (name: string) => ({
      ...projectFixture(),
      name,
    })) as ExecutionDeps["projects"]["get"];
    deps.projects = withConfigurations(deps.projects, async (projectName: string) =>
      projectName === "child"
        ? {
            ...configurationFixture(childParameters),
            projectName: "child",
            model: "gpt-child",
          }
        : null) as ExecutionDeps["projects"];
    return deps;
  }

  const script = () =>
    new FakeChannel([
      [
        toolCallChunk(0, "call_t", "delegate_child", "{\"input\":\"go\",\"image_ids\":[]}"),
        usageChunk(1, 1),
      ],
      [contentChunk("child answer"), usageChunk(1, 1)],
      [contentChunk("parent answer"), usageChunk(1, 1)],
    ]);

  async function childPrompt(channel: FakeChannel, deps: ExecutionDeps, parentOptedIn: boolean) {
    await collect(
      executeAgent(deps, {
        project: projectFixture(),
        configuration: {
          ...configurationFixture({ piiFiltering: false, callerContext: parentOptedIn }),
          subagentList: [{ name: "child" }],
          maxTurn: 50,
        },
        messages: [{ role: "user", content: "delegate" }],
        caller: CALLER,
      }),
    );
    const childCall = channel.seenParams.find((params) => params.model === "gpt-child");
    return String(childCall?.messages[0]?.content ?? "");
  }

  it("names the caller to a child that asked for one", async () => {
    const channel = script();
    const deps = transferDeps(channel, { piiFiltering: false, callerContext: true });

    const prompt = await childPrompt(channel, deps, true);

    expect(prompt).toContain("You are answering Bruce.");
    expect(prompt).toContain("Asia/Seoul");
  });

  it("leaves a child that did not ask anonymous", async () => {
    const channel = script();
    const deps = transferDeps(channel, { piiFiltering: false });

    const prompt = await childPrompt(channel, deps, true);

    expect(prompt).not.toContain("Bruce");
  });

  it("lets the child's own opt-in decide, not its parent's", async () => {
    // Each version's `callerContext` governs its own prompt. A parent that does
    // not name the caller is not a statement about the project it transfers to.
    const channel = script();
    const deps = transferDeps(channel, { piiFiltering: false, callerContext: true });

    const prompt = await childPrompt(channel, deps, false);

    expect(prompt).toContain("You are answering Bruce.");
  });
});
