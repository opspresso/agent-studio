import { describe, expect, it, vi } from "vitest";

// Fake document client whose next PutCommand outcome is controlled per test.
const { behavior, fakeClient } = vi.hoisted(() => {
  const behavior = { mode: "ok" as "ok" | "conflict" | "boom" };
  const fakeClient = {
    async send() {
      if (behavior.mode === "conflict") {
        throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
      }
      if (behavior.mode === "boom") {
        throw new Error("network partition");
      }
      return {};
    },
  };
  return { behavior, fakeClient };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

const { slackEventRepository } = await import(
  "@/infrastructure/db/repositories/slackEventRepository"
);

describe("slackEventRepository.claim", () => {
  it("returns true when the conditional put succeeds (first delivery)", async () => {
    behavior.mode = "ok";
    expect(await slackEventRepository.claim("evt-1")).toBe(true);
  });

  it("returns false when the event was already claimed (redelivery)", async () => {
    behavior.mode = "conflict";
    expect(await slackEventRepository.claim("evt-1")).toBe(false);
  });

  it("rethrows non-conditional errors instead of treating them as duplicates", async () => {
    behavior.mode = "boom";
    await expect(slackEventRepository.claim("evt-1")).rejects.toThrow(/network partition/);
  });
});
