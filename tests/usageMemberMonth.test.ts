import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageDelta } from "@/domain/usage/types";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@/infrastructure/db/client", () => ({
  getTableName: () => "test-table",
  getDocumentClient: () => ({ send }),
}));

const { DynamoUsageRepository } = await import("@/infrastructure/db/repositories/usageRepository");

const delta = (actor?: string): UsageDelta => ({
  projectName: "p",
  date: "2026-08-13",
  model: "m",
  calls: 1,
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.5,
  ...(actor ? { actor } : {}),
});

const sentInputs = () => send.mock.calls.map((call) => call[0]?.input ?? {});

beforeEach(() => {
  send.mockClear();
  send.mockResolvedValue({});
});

describe("the member month row", () => {
  it("is written third, keyed by email and UTC month, for a user actor", async () => {
    await new DynamoUsageRepository().record(delta("user:a@x.com"));

    const memberWrites = sentInputs().filter(
      (input) => input.Key?.PK === "USAGEMEMBER#a@x.com",
    );
    expect(memberWrites).toHaveLength(2);
    expect(memberWrites[0]?.Key).toEqual({ PK: "USAGEMEMBER#a@x.com", SK: "MONTH#2026-08" });
    expect(memberWrites[0]?.UpdateExpression).toContain("if_not_exists(costUsd");
    expect(memberWrites[1]?.UpdateExpression).toContain("ADD calls.#model");
    expect(memberWrites[1]?.ExpressionAttributeValues).toMatchObject({ ":cost": 0.5 });
  });

  it("is not written for project tokens, machine actors, or unattributed spend", async () => {
    // A token spends against its project's limits, never its owner's budget.
    await new DynamoUsageRepository().record(delta("project-token:a@x.com"));
    await new DynamoUsageRepository().record(delta("slack:U1"));
    await new DynamoUsageRepository().record(delta());
    expect(
      sentInputs().some((input) => String(input.Key?.PK ?? "").startsWith("USAGEMEMBER#")),
    ).toBe(false);
  });
});

describe("getMemberMonth", () => {
  it("maps the row", async () => {
    send.mockResolvedValueOnce({
      Item: { email: "a@x.com", month: "2026-08", costUsd: { m: 3 } },
    });
    await expect(new DynamoUsageRepository().getMemberMonth("a@x.com", "2026-08")).resolves.toEqual({
      email: "a@x.com",
      month: "2026-08",
      calls: {},
      inputTokens: {},
      outputTokens: {},
      costUsd: { m: 3 },
    });
  });

  it("answers null when nothing was spent", async () => {
    send.mockResolvedValueOnce({});
    await expect(
      new DynamoUsageRepository().getMemberMonth("a@x.com", "2026-08"),
    ).resolves.toBeNull();
  });
});
