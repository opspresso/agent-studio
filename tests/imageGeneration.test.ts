import { describe, expect, it } from "vitest";
import { generateImage, generateImageStream } from "@/application/image/generateImage";
import { calculateImageCost } from "@/domain/llm/models";
import type { EngineChunk } from "@/domain/llm/types";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { Project, Version } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";
import type { UsageDelta } from "@/domain/usage/types";

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
    async claimAlert() {
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
      async claimAlert() {
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
  it("delivers the picture and announces the ending", async () => {
    // Both chunks matter. The webhook runner used to assemble them by hand in
    // the composition root and emitted only the first, so a consumer reading a
    // run's termination could never see this one end.
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
    expect(chunks).toEqual([
      { image: { b64: "aGVsbG8=", mimeType: "image/png" } },
      { done: true },
    ]);
  });

  it("does not swallow a refusal into an empty stream", async () => {
    const { deps } = fakeDeps();
    const stream = generateImageStream(deps, { project, version: version("openai/gpt-5-mini") });
    await expect(stream.next()).rejects.toThrow(/does not support image generation/);
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
