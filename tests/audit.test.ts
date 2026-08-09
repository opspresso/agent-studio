import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertAuditSinkWired,
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

/**
 * The no-op above is right for a script and wrong for a server, and only boot
 * can tell them apart. These pin both halves: that the assertion actually
 * refuses an unwired process, and that the two sites which wire one still do.
 *
 * The second half is the same shape as `configuration reads`'s "still happen
 * where the exception says they do" — a wiring site that quietly stopped wiring
 * would leave the assertion reading stricter than the system is, which is the
 * same lie as no assertion at all.
 */
describe("the audit sink at boot", () => {
  it("refuses a process that would record nothing", () => {
    setAuditSink(undefined);
    expect(() => assertAuditSinkWired()).toThrow(/not wired/);
  });

  it("passes once a sink is wired", () => {
    setAuditSink(memorySink());
    expect(() => assertAuditSinkWired()).not.toThrow();
  });

  it.each([
    // The awaited boot path, for the routes that never import the root — the
    // A2A-key reveal needs nothing from it.
    "src/instrumentation.ts",
    // The processes with no instrumentation hook: the scripts and the
    // integration check compose the container and nothing else.
    "src/lib/container.ts",
  ])("%s still wires one", (path) => {
    expect(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).toContain(
      "setAuditSink(",
    );
  });

  it("is asserted on the awaited boot path", () => {
    // Wiring without reading back is what left the gap: the push can land on a
    // different module instance than the one every route reads.
    expect(readFileSync(new URL("../src/instrumentation.ts", import.meta.url), "utf8")).toContain(
      "assertAuditSinkWired()",
    );
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

  it("refuses a month that does not exist rather than answering that nothing happened", async () => {
    // `2026-13-01` has the right shape and parses to NaN, which used to make the
    // range empty — so the endpoint answered 200 with no events. For an
    // append-only trail "that is everything" is a worse answer than an error.
    setAuditSink(sink);
    await recordAudit(
      { actorEmail: "a@example.com", action: "settings.update", target: "settings:app" },
      new Date("2026-08-03T10:00:00Z"),
    );
    await expect(useCases.list({ from: "2026-13-01" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a day its month does not have, rather than rolling into the next one", async () => {
    // `2026-02-31` parses to March 3rd, which would silently return three days
    // of March under a query that named February.
    await expect(
      useCases.list({ from: "2026-02-01", to: "2026-02-31" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses an enormous range without first building it", async () => {
    // The day count is arithmetic; enumerating this range allocates a Date and a
    // string 3.6 million times, which blocks the one event loop for seconds
    // before the refusal it was always going to end in.
    const started = process.hrtime.bigint();
    await expect(
      useCases.list({ from: "0001-01-01", to: "9999-12-31" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(100);
  });
});
