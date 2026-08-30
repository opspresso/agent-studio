import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;
const { modelPreferencesRepository } = await import(
  "@/infrastructure/db/repositories/modelPreferencesRepository"
);

beforeEach(() => {
  store.rows.clear();
});

describe("modelPreferencesRepository", () => {
  it("keeps each user's favorites in its own row", async () => {
    await modelPreferencesRepository.replaceFavoriteModels("user-1", ["openai/gpt-5.4"]);
    await modelPreferencesRepository.replaceFavoriteModels("user-2", ["anthropic/claude-fable-5"]);

    await expect(modelPreferencesRepository.getFavoriteModels("user-1")).resolves.toEqual([
      "openai/gpt-5.4",
    ]);
    await expect(modelPreferencesRepository.getFavoriteModels("user-2")).resolves.toEqual([
      "anthropic/claude-fable-5",
    ]);
    expect(store.all()).toEqual([
      {
        PK: "MODELPREFERENCES#user-1",
        SK: "META",
        entityType: "MODEL_PREFERENCES",
        favoriteModels: ["openai/gpt-5.4"],
      },
      {
        PK: "MODELPREFERENCES#user-2",
        SK: "META",
        entityType: "MODEL_PREFERENCES",
        favoriteModels: ["anthropic/claude-fable-5"],
      },
    ]);
  });

  it("deletes an empty preference row", async () => {
    await modelPreferencesRepository.replaceFavoriteModels("user-1", ["openai/gpt-5.4"]);
    await modelPreferencesRepository.replaceFavoriteModels("user-1", []);
    await expect(modelPreferencesRepository.getFavoriteModels("user-1")).resolves.toEqual([]);
    expect(store.all()).toEqual([]);
  });
});
