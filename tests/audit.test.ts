import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditTarget,
  recordAudit,
  setAuditSink,
} from "@/application/audit/recordAudit";
import {
  createAuditUseCases,
  daysInRange,
  MAX_AUDIT_RANGE_DAYS,
} from "@/application/audit/auditUseCases";
import { ValidationError } from "@/application/errors";
import type { AuditRepository } from "@/domain/audit/repository";
import type { AuditEvent } from "@/domain/audit/types";
import { expiresAtSeconds, RETENTION } from "@/infrastructure/db/ttl";
import { keys } from "@/infrastructure/db/keys";

function memorySink(): AuditRepository & { rows: AuditEvent[] } {
  const rows: AuditEvent[] = [];
  return {
    rows,
    async append(event) {
      rows.push(event);
    },
    async listByDay(day) {
      return rows.filter((row) => row.createdAt.startsWith(day)).reverse();
    },
  };
}

afterEach(() => {
  setAuditSink(undefined);
  vi.restoreAllMocks();
});

describe("recordAudit", () => {
  it("is a no-op until the composition root wires a sink", async () => {
    // A script or a test that never composed the container must not fail on a
    // table it never created.
    await expect(
      recordAudit({ actorEmail: "a@example.com", action: "settings.update", target: "settings:app" }),
    ).resolves.toBeUndefined();
  });

  it("stamps the row and keeps the caller's fields", async () => {
    const sink = memorySink();
    setAuditSink(sink);
    await recordAudit(
      {
        actorEmail: "admin@example.com",
        action: "secret.reveal",
        target: auditTarget("project", "my-bot"),
        detail: "API token",
      },
      new Date("2026-08-03T10:00:00Z"),
    );
    expect(sink.rows[0]).toMatchObject({
      actorEmail: "admin@example.com",
      action: "secret.reveal",
      target: "project:my-bot",
      detail: "API token",
      createdAt: "2026-08-03T10:00:00.000Z",
    });
    expect(sink.rows[0]?.eventId).toBeTruthy();
  });

  it("logs and continues when the store refuses the write", async () => {
    // The act already happened. Refusing it after the fact because a log row
    // could not be appended would turn a storage blip into an outage of every
    // sensitive operation at once — and the log line beside each call site is
    // what remains in exactly this case.
    setAuditSink({
      append: async () => {
        throw new Error("table unavailable");
      },
      listByDay: async () => [],
    });
    await expect(
      recordAudit({ actorEmail: "a@example.com", action: "project.delete", target: "project:p" }),
    ).resolves.toBeUndefined();
  });
});

describe("auditTarget", () => {
  it("spells a target the same way everywhere", () => {
    expect(auditTarget("skill", "pdf-reader")).toBe("skill:pdf-reader");
  });
});

describe("the row a repository writes", () => {
  it("carries an expiresAt derived from the retention variable", () => {
    const createdAt = "2026-08-03T10:00:00.000Z";
    const expected = expiresAtSeconds(createdAt, RETENTION.auditDays);
    expect(expected).toBe(Math.floor(Date.parse(createdAt) / 1000) + RETENTION.auditDays * 86_400);
  });

  it("is keyed by the UTC day it happened on, newest last within the day", () => {
    const key = keys.auditEvent("2026-08-03", "2026-08-03T10:00:00.000Z", "e1");
    expect(key.PK).toBe("AUDIT#2026-08-03");
    // createdAt leads the sort key, so a descending query is newest-first.
    expect(key.SK.startsWith("2026-08-03T10:00:00.000Z")).toBe(true);
    expect(keys.auditDayPartition("2026-08-03")).toBe(key.PK);
  });
});

describe("reading a range", () => {
  let useCases: ReturnType<typeof createAuditUseCases>;
  let sink: ReturnType<typeof memorySink>;

  beforeEach(() => {
    sink = memorySink();
    useCases = createAuditUseCases(sink);
  });

  it("walks a range newest day first", () => {
    expect(daysInRange("2026-08-01", "2026-08-03")).toEqual([
      "2026-08-03",
      "2026-08-02",
      "2026-08-01",
    ]);
  });

  it("defaults `to` to `from`", async () => {
    setAuditSink(sink);
    await recordAudit(
      { actorEmail: "a@example.com", action: "settings.update", target: "settings:app" },
      new Date("2026-08-03T10:00:00Z"),
    );
    expect(await useCases.list({ from: "2026-08-03" })).toHaveLength(1);
    expect(await useCases.list({ from: "2026-08-02" })).toHaveLength(0);
  });

  it("refuses a malformed day rather than querying a partition that cannot exist", async () => {
    await expect(useCases.list({ from: "03-08-2026" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a reversed range", async () => {
    await expect(useCases.list({ from: "2026-08-03", to: "2026-08-01" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("refuses a range wider than the day budget", async () => {
    const from = "2026-01-01";
    const to = "2026-12-31";
    expect(daysInRange(from, to).length).toBeGreaterThan(MAX_AUDIT_RANGE_DAYS);
    await expect(useCases.list({ from, to })).rejects.toBeInstanceOf(ValidationError);
  });
});
