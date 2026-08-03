import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake document client, like the other repository tests: what matters here is
// the item that would be written, not that DynamoDB accepts it.
const { sent, items, fakeClient } = vi.hoisted(() => {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const items: Record<string, unknown>[] = [];
  const fakeClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      return command.constructor.name === "QueryCommand" ? { Items: items } : {};
    },
  };
  return { sent, items, fakeClient };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

const { auditRepository } = await import("@/infrastructure/db/repositories/auditRepository");
const { RETENTION } = await import("@/infrastructure/db/ttl");

const event = {
  id: "e1",
  action: "secret.reveal" as const,
  actorEmail: "admin@x.com",
  target: "settings:a2a-key",
  createdAt: "2026-08-01T10:00:00.000Z",
};

beforeEach(() => {
  sent.length = 0;
  items.length = 0;
});

describe("auditRepository.append", () => {
  it("partitions by the UTC day it happened on and sorts by time within it", async () => {
    await auditRepository.append(event);
    expect(sent[0]?.input.Item).toMatchObject({
      PK: "AUDIT#2026-08-01",
      SK: "EVENT#2026-08-01T10:00:00.000Z#e1",
      entityType: "AuditEvent",
    });
  });

  it("carries an expiresAt derived from the retention variable", async () => {
    await auditRepository.append(event);
    const item = sent[0]?.input.Item as { expiresAt: number };
    const expected =
      Math.floor(Date.parse(event.createdAt) / 1000) + RETENTION.auditDays * 86_400;
    expect(item.expiresAt).toBe(expected);
    // A year by default — the question these rows answer is asked long after.
    expect(RETENTION.auditDays).toBe(365);
  });

  it("respects an AUDIT_RETENTION_DAYS override", async () => {
    process.env.AUDIT_RETENTION_DAYS = "30";
    try {
      await auditRepository.append(event);
      const item = sent[0]?.input.Item as { expiresAt: number };
      expect(item.expiresAt).toBe(Math.floor(Date.parse(event.createdAt) / 1000) + 30 * 86_400);
    } finally {
      delete process.env.AUDIT_RETENTION_DAYS;
    }
  });
});

describe("auditRepository.listByDay", () => {
  it("reads the day partition newest-first and drops rows past their TTL", async () => {
    items.push(
      { ...event, id: "live", expiresAt: Math.floor(Date.now() / 1000) + 3_600 },
      { ...event, id: "expired", expiresAt: Math.floor(Date.now() / 1000) - 3_600 },
    );
    const result = await auditRepository.listByDay("2026-08-01");
    expect(sent[0]?.input).toMatchObject({
      ExpressionAttributeValues: { ":pk": "AUDIT#2026-08-01" },
      ScanIndexForward: false,
    });
    expect(result.map((row) => row.id)).toEqual(["live"]);
  });
});
