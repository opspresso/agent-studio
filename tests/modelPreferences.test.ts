import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelPreferenceUseCases } from "@/application/llm/modelPreferences";
import { MAX_FAVORITE_MODELS } from "@/domain/llm/modelPreferences";
import { log } from "@/shared/logger";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const repository = {
    getFavoriteModels: vi.fn(async () => ["openai/gpt-5.4"]),
    replaceFavoriteModels: vi.fn(async () => undefined),
    changeFavoriteModels: vi.fn(async (_userId: string, change: (ids: string[]) => string[]) => change(["openai/gpt-5.4"])),
  };
  return { repository, useCases: createModelPreferenceUseCases(repository) };
}

describe("model preference use cases", () => {
  it("reads preferences by stable user id", async () => {
    const { repository, useCases } = fixture();
    await expect(useCases.list("user-1")).resolves.toEqual(["openai/gpt-5.4"]);
    expect(repository.getFavoriteModels).toHaveBeenCalledWith("user-1");
  });

  it("keeps optional model lists available when personal preferences cannot be read", async () => {
    const { repository, useCases } = fixture();
    const failure = new Error("preferences unavailable");
    repository.getFavoriteModels.mockRejectedValue(failure);
    const warning = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    await expect(useCases.list("user-1")).rejects.toBe(failure);
    await expect(useCases.listOptional("user-1")).resolves.toEqual([]);
    expect(warning).toHaveBeenCalledWith("models", "model favorites unavailable for selection options", failure);
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

  it("changes one model against the stored list and permits removing a retired ID", async () => {
    const { repository, useCases } = fixture();
    await expect(useCases.setFavorite("user-1", "anthropic/claude-fable-5", true))
      .resolves.toEqual(["anthropic/claude-fable-5", "openai/gpt-5.4"]);
    await expect(useCases.setFavorite("user-1", "openai/gpt-5.4", false)).resolves.toEqual([]);
    await expect(useCases.setFavorite("user-1", "openai/not-a-model", true)).rejects.toThrow(/Unknown or retired/);
    expect(repository.changeFavoriteModels).toHaveBeenCalledTimes(2);
  });
});
