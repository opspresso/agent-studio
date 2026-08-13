import { describe, expect, it, vi } from "vitest";

/**
 * `put` writes the whole settings object, but `fromItem` reads back only what
 * it names — a field missing there is written and then silently dropped on the
 * next read, surviving exactly until the process restarts. `unknownModelPolicy`
 * shipped that way: the /settings page stored a `refuse` override that the run
 * bracket never saw again. This pins the read against the fields the runtime
 * consumes, non-string shapes included.
 */
const send = vi.fn();
vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => ({ send }),
  getTableName: () => "test-table",
}));

const { settingsRepository } = await import(
  "@/infrastructure/db/repositories/settingsRepository"
);

describe("settingsRepository.get", () => {
  it("reads back what put writes — unknownModelPolicy and enabledModels included", async () => {
    const stored = {
      adminEmails: "admin@example.com",
      unknownModelPolicy: "refuse",
      enabledModels: ["openai/gpt-5.4"],
      llmProviders: [{ name: "openai", baseUrl: "https://llm.example.com/v1", apiKey: "enc:v1:x" }],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    send.mockResolvedValueOnce({
      Item: { PK: "SETTINGS#app", SK: "META", entityType: "SETTINGS", ...stored },
    });

    await expect(settingsRepository.get()).resolves.toEqual(stored);
  });

  it("returns null when no settings item exists", async () => {
    send.mockResolvedValueOnce({});
    await expect(settingsRepository.get()).resolves.toBeNull();
  });
});
