import { describe, expect, it } from "vitest";
import { generateImage } from "@/application/image/generateImage";
import { calculateImageCost } from "@/domain/llm/models";
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
  const imageChannel: ImageChannel = {
    async generateImage(params) {
      prompts.push(params.prompt);
      return {
        b64: "aGVsbG8=",
        mimeType: "image/png",
        usage: { textInputTokens: 100, imageInputTokens: 0, imageOutputTokens: 4160 },
      };
    },
  };
  const usage: UsageRepository = {
    async record(delta) {
      recorded.push(delta);
    },
    async listByProject() {
      return [];
    },
    async listByDateRange() {
      return [];
    },
  };
  return { deps: { imageChannel, usage }, recorded, prompts };
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
