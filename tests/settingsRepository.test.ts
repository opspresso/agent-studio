import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";

/**
 * `update` writes the whole settings object, but `fromItem` reads back only what
 * it names — a field missing there is written and then silently dropped on the
 * next read, surviving exactly until the process restarts. `unknownModelPolicy`
 * shipped that way: the /settings page stored a `refuse` override that the run
 * bracket never saw again. This pins the read against the fields the runtime
 * consumes, non-string shapes included.
 */
vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { settingsRepository } = await import(
  "@/infrastructure/db/repositories/settingsRepository"
);

beforeEach(() => {
  store.rows.clear();
});

describe("settingsRepository", () => {
  it("reads back what update writes — every AppSettings field, by construction", async () => {
    // `Required<AppSettings>` is the recurrence killer: a field added to the
    // type without a value here fails `pnpm typecheck`, and a value here that
    // `fromItem` drops fails the equality below. `unknownModelPolicy` shipped
    // dropped-on-read once and `selfHostedModels` shipped that way twice over —
    // declarations vanished within a tick and the next unrelated save deleted
    // the stored row's copy for good.
    const stored: Required<import("@/domain/settings/types").AppSettings> = {
      adminEmails: "admin@example.com",
      allowedEmailDomains: "example.com",
      llmBaseUrl: "https://llm.example.com/v1",
      llmApiKey: "enc:v1:key",
      llmProviders: [{ name: "openai", baseUrl: "https://llm.example.com/v1", apiKey: "enc:v1:x" }],
      embeddingModel: "selfhosted/Qwen/Qwen3-Embedding-4B",
      rerankerModel: "selfhosted/Qwen/Qwen3-Reranker-0.6B",
      rerankerMinScore: "0.02",
      pluginsRepo: "opspresso/agent-plugins",
      pluginsRepoBranch: "main",
      githubToken: "enc:v1:token",
      a2aApiKey: "enc:v1:a2a",
      publicBaseUrl: "https://studio.example.com",
      artifactAccessMode: "public",
      unknownModelPolicy: "refuse",
      hiddenModels: ["openai/gpt-5.4"],
      selfHostedModels: [
        {
          id: "selfhosted/qwen/qwen3.8-27b",
          provider: "selfhosted",
          family: "qwen/qwen3.8-27b",
          maker: "qwen",
          displayName: "Qwen3.8 27B",
          pricing: { inputPer1M: 0, outputPer1M: 0 },
          capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
          contextWindow: 262144,
          maxTokens: 8192,
        },
      ],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await settingsRepository.update(() => stored);

    // The row lives at the one settings address, typed, with nothing lost.
    expect(store.all()).toEqual([
      { PK: "SETTINGS#app", SK: "META", entityType: "SETTINGS", ...stored },
    ]);
    await expect(settingsRepository.get()).resolves.toEqual(stored);
  });

  it("returns null when no settings item exists", async () => {
    await expect(settingsRepository.get()).resolves.toBeNull();
  });

  it("merges concurrent mutations against the latest stored row", async () => {
    await Promise.all([
      settingsRepository.update((current) => ({
        ...(current ?? { updatedAt: "" }),
        publicBaseUrl: "https://studio.example.com",
        updatedAt: "2026-01-01T00:00:00Z",
      })),
      settingsRepository.update((current) => ({
        ...(current ?? { updatedAt: "" }),
        embeddingModel: "openai/text-embedding-3-small",
        updatedAt: "2026-01-01T00:00:01Z",
      })),
    ]);

    await expect(settingsRepository.get()).resolves.toMatchObject({
      publicBaseUrl: "https://studio.example.com",
      embeddingModel: "openai/text-embedding-3-small",
    });
  });
});
