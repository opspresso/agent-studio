import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageDelta } from "@/domain/usage/types";

const { send, queryAll } = vi.hoisted(() => ({ send: vi.fn(), queryAll: vi.fn() }));

vi.mock("@/infrastructure/db/client", () => ({
  getTableName: () => "test-table",
  getDocumentClient: () => ({ send }),
}));
vi.mock("@/infrastructure/db/query", () => ({ queryAll }));

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

const sentInputs = () =>
  send.mock.calls.map((call) => call[0]?.input ?? {});

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({});
  queryAll.mockResolvedValue([]);
});

describe("the member day row", () => {
  it("is written third, keyed by email, UTC day and project, for a user actor", async () => {
    await new DynamoUsageRepository().record(delta("user:a@x.com"));

    const memberWrites = sentInputs().filter((input) => input.Key?.PK === "USAGEMEMBER#a@x.com");
    expect(memberWrites).toHaveLength(2);
    expect(memberWrites[0]?.Key).toEqual({ PK: "USAGEMEMBER#a@x.com", SK: "DATE#2026-08-13#p" });
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

describe("listMemberDays", () => {
  it("queries the member's own partition across the day range", async () => {
    queryAll.mockResolvedValue([
      {
        email: "a@x.com",
        projectName: "p",
        date: "2026-08-13",
        costUsd: { m: 3 },
        calls: { m: 2 },
      },
    ]);

    await expect(
      new DynamoUsageRepository().listMemberDays("a@x.com", "2026-08-01", "2026-08-13"),
    ).resolves.toEqual([
      {
        email: "a@x.com",
        projectName: "p",
        date: "2026-08-13",
        calls: { m: 2 },
        inputTokens: {},
        outputTokens: {},
        costUsd: { m: 3 },
      },
    ]);
    expect(queryAll).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: "test-table",
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": "USAGEMEMBER#a@x.com",
          ":from": "DATE#2026-08-01",
          // Past every project name on the last day.
          ":to": "DATE#2026-08-13\uffff",
        },
      }),
    );
  });

  it("answers an empty list when nothing was spent", async () => {
    await expect(
      new DynamoUsageRepository().listMemberDays("a@x.com", "2026-08-01", "2026-08-13"),
    ).resolves.toEqual([]);
  });
});
