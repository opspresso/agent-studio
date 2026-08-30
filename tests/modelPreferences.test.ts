import { describe, expect, it, vi } from "vitest";
import { createModelPreferenceUseCases } from "@/application/llm/modelPreferences";
import { MAX_FAVORITE_MODELS } from "@/domain/llm/modelPreferences";

function fixture() {
  const repository = {
    getFavoriteModels: vi.fn(async () => ["openai/gpt-5.4"]),
    replaceFavoriteModels: vi.fn(async () => undefined),
  };
  return { repository, useCases: createModelPreferenceUseCases(repository) };
}

describe("model preference use cases", () => {
  it("reads preferences by stable user id", async () => {
    const { repository, useCases } = fixture();
    await expect(useCases.list("user-1")).resolves.toEqual(["openai/gpt-5.4"]);
    expect(repository.getFavoriteModels).toHaveBeenCalledWith("user-1");
  });

  it("stores known models sorted and deduplicated", async () => {
    const { repository, useCases } = fixture();
    await expect(
      useCases.replace("user-1", [
        "openai/gpt-5.4",
        "anthropic/claude-fable-5",
        "openai/gpt-5.4",
      ]),
    ).resolves.toEqual(["anthropic/claude-fable-5", "openai/gpt-5.4"]);
    expect(repository.replaceFavoriteModels).toHaveBeenCalledWith("user-1", [
      "anthropic/claude-fable-5",
      "openai/gpt-5.4",
    ]);
  });

  it("rejects unknown models and an unbounded preference list", async () => {
    const { repository, useCases } = fixture();
    await expect(useCases.replace("user-1", ["openai/not-a-model"])).rejects.toThrow(
      /Unknown or retired model ids/,
    );
    await expect(
      useCases.replace(
        "user-1",
        Array.from({ length: MAX_FAVORITE_MODELS + 1 }, (_, index) => `model-${index}`),
      ),
    ).rejects.toThrow(`At most ${MAX_FAVORITE_MODELS}`);
    expect(repository.replaceFavoriteModels).not.toHaveBeenCalled();
  });
});
