import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake document client: records what it was sent and fails on demand, so the
// tests can pin the conditional-write contract without DynamoDB.
const { behavior, sent, fakeClient } = vi.hoisted(() => {
  const behavior = { mode: "ok" as "ok" | "conflict" | "boom" };
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const fakeClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      if (behavior.mode === "conflict") {
        throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
      }
      if (behavior.mode === "boom") {
        throw new Error("network partition");
      }
      return {};
    },
  };
  return { behavior, sent, fakeClient };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

const { slackEventRepository } = await import(
  "@/infrastructure/db/repositories/slackEventRepository"
);

const NOW = 1_700_000_000;
const LEASE_UNTIL = NOW + 660;

beforeEach(() => {
  behavior.mode = "ok";
  sent.length = 0;
});

describe("slackEventRepository.claim", () => {
  it("returns true when the conditional put succeeds (first delivery)", async () => {
    expect(await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL)).toBe(true);
  });

  it("returns false when the event is settled or another instance holds the lease", async () => {
    behavior.mode = "conflict";
    expect(await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL)).toBe(false);
  });

  it("rethrows non-conditional errors instead of treating them as duplicates", async () => {
    behavior.mode = "boom";
    await expect(slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL)).rejects.toThrow(
      /network partition/,
    );
  });

  /**
   * The point of the lease: an instance that died mid-processing leaves a
   * `claimed` row behind, and a redelivery must be able to take it over rather
   * than be refused as a duplicate of work that never happened. A `failed`
   * attempt is reclaimable outright — that is what settling as failed is *for*,
   * and the condition used to say only `claimed`, so a failed event was
   * refused as a duplicate forever (the integration check is what caught it).
   * Equally, a row that is `done`, or written before claims carried state, must
   * never be reclaimed, or a handled event would be replayed.
   */
  it("admits a claim whose lease expired or whose attempt failed, and never a settled one", async () => {
    await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL);
    const put = sent.at(-1);
    expect(put?.name).toBe("PutCommand");
    expect(put?.input.ConditionExpression).toBe(
      "attribute_not_exists(PK) OR #state = :failed OR (#state = :claimed AND leaseExpiresAt < :now)",
    );
    expect(put?.input.ExpressionAttributeValues).toMatchObject({
      ":claimed": "claimed",
      ":failed": "failed",
      ":now": NOW,
    });
  });

  it("writes the lease deadline and a claimed state on the row", async () => {
    await slackEventRepository.claim("evt-1", NOW, LEASE_UNTIL);
    expect(sent.at(-1)?.input.Item).toMatchObject({
      state: "claimed",
      leaseExpiresAt: LEASE_UNTIL,
      expiresAt: NOW + 60 * 60 * 24,
    });
  });
});

describe("slackEventRepository.settle", () => {
  it("retires a completed claim and leaves no live lease", async () => {
    await slackEventRepository.settle("evt-1", "done");
    const update = sent.at(-1);
    expect(update?.name).toBe("UpdateCommand");
    expect(update?.input.ExpressionAttributeValues).toMatchObject({
      ":state": "done",
      ":lease": 0,
    });
  });

  /** A failed attempt must stay retryable, not look like a success. */
  it("marks a failed attempt failed so a redelivery can reclaim it", async () => {
    await slackEventRepository.settle("evt-1", "failed");
    expect(sent.at(-1)?.input.ExpressionAttributeValues).toMatchObject({
      ":state": "failed",
      ":lease": 0,
    });
  });

  it("ignores a missing row (TTL purge) rather than failing the delivered response", async () => {
    behavior.mode = "conflict";
    await expect(slackEventRepository.settle("evt-1", "done")).resolves.toBeUndefined();
  });

  it("rethrows non-conditional errors", async () => {
    behavior.mode = "boom";
    await expect(slackEventRepository.settle("evt-1", "done")).rejects.toThrow(
      /network partition/,
    );
  });
});
