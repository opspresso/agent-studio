import { describe, expect, it } from "vitest";
import { generateImage, generateImageStream } from "@/application/image/generateImage";
import { calculateImageCost } from "@/domain/llm/models";
import { statusForError, UpstreamError, ValidationError } from "@/application/errors";
import type { EngineChunk } from "@/domain/llm/types";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { Project, Version } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";
import type { UsageDelta } from "@/domain/usage/types";
import type { Trace } from "@/domain/trace/types";

const project: Project = {
  name: "img-proj",
  displayName: "Image Project",
  description: "",
  projectType: "image",
  ownerEmail: "t@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function version(model: string, template = "A cat wearing {{style}} clothes"): Version {
  return {
    projectName: project.name,
    versionName: "1",
    systemPrompt: "",
    userPromptTemplate: template,
    model,
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function fakeDeps() {
  const recorded: UsageDelta[] = [];
  const prompts: string[] = [];
  const edits: Array<{ prompt: string; sources: string[] }> = [];
  const imageChannel: ImageChannel = {
    async generateImage(params) {
      prompts.push(params.prompt);
      return {
        b64: "aGVsbG8=",
        mimeType: "image/png",
        usage: { textInputTokens: 100, imageInputTokens: 0, imageOutputTokens: 4160 },
      };
    },
    async editImage(params) {
      edits.push({ prompt: params.prompt, sources: params.images.map((i) => i.b64) });
      return {
        b64: "ZWRpdGVk",
        mimeType: "image/png",
        usage: { textInputTokens: 20, imageInputTokens: 300, imageOutputTokens: 1000 },
      };
    },
  };
  const usage: UsageRepository = {
    async record(delta) {
      recorded.push(delta);
    },
    async getDay() {
      return null;
    },
    async listMemberDays() {
      return [];
    },
    async claimAlert() {
      return false;
    },
    async claimMonthAlert() {
      return false;
    },
    async listActorsByProject() {
      return [];
    },
    async listByProject() {
      return [];
    },
    async listByDateRange() {
      return [];
    },
  };
  return { deps: { imageChannel, usage }, recorded, prompts, edits };
}

/**
 * An image project with somewhere to keep what it draws.
 *
 * The point of wiring this at the bracket is that an image project is only one
 * of four producers — but it is the one no chunk-stream wrapper covers, since
 * `/predict` and the A2A executor reach the use case directly.
 */
function fakeArtifacts() {
  const rowsWritten: Array<Record<string, unknown>> = [];
  const objects = {
    async put(input: { key: string; bytes: Uint8Array; mimeType: string }) {
      puts.push(input);
    },
    async sign(key: string) {
      return `https://signed/${key}`;
    },
    async delete() {},
  };
  const puts: Array<{ key: string; bytes: Uint8Array; mimeType: string }> = [];
  const rows = {
    async put(artifact: Record<string, unknown>) {
      rowsWritten.push(artifact);
    },
    async get() {
      return null;
    },
    async listByProject() {
      return [];
    },
    async listByOwner() {
      return [];
    },
    async delete() {},
  };
  return { storage: { rows, objects } as never, rowsWritten, puts };
}

describe("generateImage artifacts", () => {
  it("keeps what an image project drew, which no chunk wrapper would reach", async () => {
    // `/predict` and the A2A executor call this use case directly, so a capture
    // that only wrapped the agent stream would lose every picture they make.
    const { deps } = fakeDeps();
    const { storage, rowsWritten, puts } = fakeArtifacts();
    const result = await generateImage(
      { ...deps, artifacts: storage },
      { project, version: version("openai/gpt-image-2"), variables: { style: "hanbok" } },
    );
    expect(puts).toHaveLength(1);
    expect(rowsWritten[0]).toMatchObject({
      kind: "image",
      source: "generated",
      projectName: "img-proj",
      versionName: "1",
      prompt: "A cat wearing hanbok clothes",
      // The model that actually drew it, so the gallery can say what made this.
      model: "openai/gpt-image-2",
    });
    // The caller is told where it went, so its own answer can carry the address.
    expect(result.artifactId).toBe(rowsWritten[0]?.artifactId);
    expect(result.key).toBe(rowsWritten[0]?.key);
  });

  it("answers exactly as before when the deployment keeps nothing", async () => {
    const { deps } = fakeDeps();
    const result = await generateImage(deps, { project, version: version("openai/gpt-image-2") });
    expect(result.imageBase64).toBe("aGVsbG8=");
    expect(result.artifactId).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it("puts the stored reference on the stream's image chunk", async () => {
    const { deps } = fakeDeps();
    const { storage, rowsWritten } = fakeArtifacts();
    const chunks: EngineChunk[] = [];
    for await (const chunk of generateImageStream(
      { ...deps, artifacts: storage },
      { project, version: version("openai/gpt-image-2") },
    )) {
      chunks.push(chunk);
    }
    // The bytes stay: an image project's answer *is* the picture, and a live
    // consumer renders it from the chunk.
    expect(chunks[0]?.image).toMatchObject({
      b64: "aGVsbG8=",
      model: "openai/gpt-image-2",
      artifactId: rowsWritten[0]?.artifactId,
      key: rowsWritten[0]?.key,
    });
  });
});

describe("generateImage", () => {
  it("rejects models without the imageGeneration capability", async () => {
    const { deps } = fakeDeps();
    await expect(
      generateImage(deps, { project, version: version("openai/gpt-5-mini") }),
    ).rejects.toThrow(/does not support image generation/);
  });

  it("renders the version template and records usage with image-token cost", async () => {
    const { deps, recorded, prompts } = fakeDeps();
    const result = await generateImage(deps, {
      project,
      version: version("openai/gpt-image-2"),
      variables: { style: "hanbok" },
    });
    expect(prompts[0]).toBe("A cat wearing hanbok clothes");
    expect(result.imageBase64).toBe("aGVsbG8=");
    // 100 text tokens * $5/1M + 4160 image output tokens * $30/1M
    const expectedCost = (100 * 5 + 4160 * 30) / 1_000_000;
    expect(result.usage.costUsd).toBeCloseTo(expectedCost, 10);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      projectName: "img-proj",
      model: "openai/gpt-image-2",
      calls: 1,
      inputTokens: 100,
      outputTokens: 4160,
    });
  });

  it("passes a deadline-composed signal to the channel and propagates caller cancellation", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const imageChannel: ImageChannel = {
      async editImage() {
        throw new Error("editImage is not part of the generate use case");
      },
      async generateImage(params) {
        signals.push(params.signal);
        return {
          b64: "aGk=",
          mimeType: "image/png",
          usage: { textInputTokens: 1, imageInputTokens: 0, imageOutputTokens: 1 },
        };
      },
    };
    const usage: UsageRepository = {
      async record() {},
      async getDay() {
        return null;
      },
      async listMemberDays() {
        return [];
      },
      async claimAlert() {
        return false;
      },
      async claimMonthAlert() {
        return false;
      },
      async listActorsByProject() {
        return [];
      },
      async listByProject() {
        return [];
      },
      async listByDateRange() {
        return [];
      },
    };
    const controller = new AbortController();
    await generateImage(
      { imageChannel, usage },
      { project, version: version("openai/gpt-image-2"), prompt: "x", signal: controller.signal },
    );

    // The channel receives a deadline-composed signal (not the caller's own),
    // but a caller abort still flows through it to cancel the HTTP request.
    const sent = signals[0];
    expect(sent).toBeInstanceOf(AbortSignal);
    expect(sent).not.toBe(controller.signal);
    expect(sent?.aborted).toBe(false);
    controller.abort();
    expect(sent?.aborted).toBe(true);
  });

  it("prefers a direct prompt over the template and rejects empty prompts", async () => {
    const { deps, prompts } = fakeDeps();
    await generateImage(deps, {
      project,
      version: version("openai/gpt-image-2"),
      prompt: "direct prompt wins",
    });
    expect(prompts[0]).toBe("direct prompt wins");

    await expect(
      generateImage(deps, { project, version: version("openai/gpt-image-2", "") }),
    ).rejects.toThrow(/prompt is empty/);
  });

  it("prepends the version's system prompt as style, over template and direct prompt alike", async () => {
    const { deps, prompts, edits } = fakeDeps();
    const styled = { ...version("openai/gpt-image-2"), systemPrompt: "Watercolor, no text." };

    await generateImage(deps, { project, version: styled, variables: { style: "hanbok" } });
    expect(prompts[0]).toBe("Watercolor, no text.\n\nA cat wearing hanbok clothes");

    await generateImage(deps, {
      project,
      version: styled,
      prompt: "make it night",
      images: [{ b64: "c291cmNl", mimeType: "image/png" }],
    });
    expect(edits[0]).toEqual({
      prompt: "Watercolor, no text.\n\nmake it night",
      sources: ["c291cmNl"],
    });
  });

  it("style alone is not a subject: the empty-prompt refusal still stands", async () => {
    const { deps } = fakeDeps();
    const styled = { ...version("openai/gpt-image-2", ""), systemPrompt: "Watercolor." };
    await expect(generateImage(deps, { project, version: styled })).rejects.toThrow(
      /prompt is empty/,
    );
  });

  it("edits the source images when any are supplied", async () => {
    const { deps, edits, prompts, recorded } = fakeDeps();

    const result = await generateImage(deps, {
      project,
      version: version("openai/gpt-image-2"),
      prompt: "make it night",
      images: [{ b64: "c291cmNl", mimeType: "image/png" }],
    });

    expect(edits).toEqual([{ prompt: "make it night", sources: ["c291cmNl"] }]);
    expect(prompts).toEqual([]); // the generate endpoint was not touched
    expect(result.imageBase64).toBe("ZWRpdGVk");
    // Text + image input tokens are billed together, same as the generate path.
    expect(recorded[0]).toMatchObject({ inputTokens: 320, outputTokens: 1000 });
  });

  it("records flat source-image charges for xAI edits", async () => {
    const { deps, recorded } = fakeDeps();

    await generateImage(deps, {
      project,
      version: version("xai/grok-imagine-image-2.0"),
      prompt: "combine them",
      images: [
        { b64: "b25l", mimeType: "image/png" },
        { b64: "dHdv", mimeType: "image/png" },
      ],
    });

    // The picture ($0.06) plus xAI's flat charge for each source image ($0.01).
    expect(recorded[0]?.costUsd).toBeCloseTo(0.08, 10);
  });

  it("generates when the images list is present but empty", async () => {
    const { deps, edits, prompts } = fakeDeps();

    await generateImage(deps, {
      project,
      version: version("openai/gpt-image-2"),
      prompt: "a cat",
      images: [],
    });

    expect(edits).toEqual([]);
    expect(prompts).toEqual(["a cat"]);
  });

  it("still returns the image when usage recording fails", async () => {
    // The provider already generated and billed the image; a telemetry write
    // failure must not discard it.
    const { deps } = fakeDeps();
    deps.usage.record = async () => {
      throw new Error("dynamodb throttled");
    };

    const result = await generateImage(deps, {
      project,
      version: version("openai/gpt-image-2"),
      prompt: "a cat",
    });

    expect(result.imageBase64).toBe("aGVsbG8=");
    expect(result.usage.outputTokens).toBe(4160);
  });
});

describe("generateImageStream", () => {
  it("delivers the picture, what it cost, and the ending", async () => {
    // Every chunk matters. The webhook runner would assemble these by hand in
    // the composition root and emitted only the picture, so a consumer reading a
    // run's termination could never see this one end, and one totalling a run
    // off the stream — as collectRun does — would read it as free.
    const { deps, prompts } = fakeDeps();
    const chunks: EngineChunk[] = [];
    for await (const chunk of generateImageStream(deps, {
      project,
      version: version("openai/gpt-image-2"),
      prompt: "a fox",
    })) {
      chunks.push(chunk);
    }

    expect(prompts).toEqual(["a fox"]);
    // 100 text tokens * $5/1M + 4160 image output tokens * $30/1M
    const expectedCost = (100 * 5 + 4160 * 30) / 1_000_000;
    expect(chunks).toEqual([
      { image: { b64: "aGVsbG8=", mimeType: "image/png", model: "openai/gpt-image-2" } },
      { usage: { inputTokens: 100, outputTokens: 4160, costUsd: expectedCost } },
      { done: true },
    ]);
  });

  it("stamps a sampled trace id on every image stream chunk", async () => {
    const { deps } = fakeDeps();
    const traces: Trace[] = [];
    const chunks: EngineChunk[] = [];
    for await (const chunk of generateImageStream(
      {
        ...deps,
        traces: {
          put: async (trace) => void traces.push(trace),
          get: async () => null,
          listByProject: async () => traces,
        },
        traceSampleRate: 1,
        sample: () => 0,
      },
      { project, version: version("openai/gpt-image-2"), prompt: "a fox" },
    )) {
      chunks.push(chunk);
    }

    expect(traces).toHaveLength(1);
    expect(chunks.every((chunk) => chunk.traceId === traces[0]?.traceId)).toBe(true);
  });

  it("does not swallow a refusal into an empty stream", async () => {
    const { deps } = fakeDeps();
    const stream = generateImageStream(deps, { project, version: version("openai/gpt-5-mini") });
    await expect(stream.next()).rejects.toThrow(/does not support image generation/);
  });
});

/**
 * The predict route answers with a body, so a throw here becomes a status. An
 * untyped one becomes "Internal server error", which is what hid an xAI 404 for
 * a model the endpoint does not host behind a message that named nothing.
 */
describe("a provider refusal is reported as one", () => {
  function refusing(error: unknown) {
    const { deps } = fakeDeps();
    return {
      ...deps,
      imageChannel: {
        async generateImage(): Promise<never> {
          throw error;
        },
        async editImage(): Promise<never> {
          throw error;
        },
      },
    };
  }

  it("keeps the provider's words and names the model that failed", async () => {
    const deps = refusing(new Error("404 The requested resource was not found."));

    const thrown = await generateImage(deps, {
      project,
      version: version("xai/grok-imagine-image"),
      prompt: "a cat",
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UpstreamError);
    expect(statusForError(thrown)).toBe(502);
    expect((thrown as Error).message).toContain("xai/grok-imagine-image");
    expect((thrown as Error).message).toContain("The requested resource was not found.");
  });

  it("leaves an AppError's own status alone", async () => {
    const deps = refusing(new ValidationError("Image prompt is empty"));

    const thrown = await generateImage(deps, {
      project,
      version: version("openai/gpt-image-2"),
      prompt: "a cat",
    }).catch((error: unknown) => error);

    expect(statusForError(thrown)).toBe(400);
  });

  it("does not turn the caller walking away into an upstream failure", async () => {
    // What a channel sees when the caller's signal aborts mid-request: fetch
    // rejects with the abort *reason*. Next.js aborts `request.signal` with its
    // own `ResponseAborted` — an Error whose name is not `AbortError` and whose
    // message is empty — so a check on the name reads a reload as a provider
    // refusing with nothing to say. The signal is what decides.
    const controller = new AbortController();
    const responseAborted = new Error();
    responseAborted.name = "ResponseAborted";
    const { deps } = fakeDeps();
    const traces: Trace[] = [];
    const abortingChannel: ImageChannel = {
      async editImage(): Promise<never> {
        throw new Error("not this path");
      },
      async generateImage(): Promise<never> {
        controller.abort(responseAborted);
        throw responseAborted;
      },
    };

    const thrown = await generateImage(
      {
        ...deps,
        imageChannel: abortingChannel,
        traces: {
          put: async (trace) => void traces.push(trace),
          get: async () => null,
          listByProject: async () => traces,
        },
        traceSampleRate: 1,
        sample: () => 0,
      },
      { project, version: version("openai/gpt-image-2"), prompt: "a cat", signal: controller.signal },
    ).catch((error: unknown) => error);

    expect(thrown).toBe(responseAborted);
    expect(thrown).not.toBeInstanceOf(UpstreamError);
    expect(statusForError(thrown)).toBeNull();
    expect(traces[0]?.status).toBe("cancelled");
    expect(traces[0]?.error).toBeUndefined();
  });

  it("still reports a provider that aborted on its own as a failure", async () => {
    // An AbortError with no aborted caller signal is the adapter's own doing —
    // the person is still waiting for an answer, and this is it.
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const deps = refusing(abort);

    const thrown = await generateImage(deps, {
      project,
      version: version("openai/gpt-image-2"),
      prompt: "a cat",
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(UpstreamError);
    expect(statusForError(thrown)).toBe(502);
  });
});

describe("calculateImageCost", () => {
  it("returns 0 for unknown models", () => {
    expect(
      calculateImageCost("nope/none", {
        textInputTokens: 1,
        imageInputTokens: 1,
        imageOutputTokens: 1,
      }),
    ).toBe(0);
  });
});
