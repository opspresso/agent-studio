import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertAuditSinkWired,
  auditTarget,
  recordAudit,
  setAuditSink,
} from "@/application/audit/recordAudit";
import {
  AUDIT_PAGE_SIZE,
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
    async listByDay(day, limit, after) {
      return rows
        .filter((row) => row.createdAt.startsWith(day))
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.eventId.localeCompare(a.eventId),
        )
        .filter(
          (row) =>
            !after ||
            row.createdAt < after.createdAt ||
            (row.createdAt === after.createdAt && row.eventId < after.eventId),
        )
        .slice(0, limit);
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
        target: auditTarget("agent", "my-bot"),
        detail: "API token",
      },
      new Date("2026-08-03T10:00:00Z"),
    );
    expect(sink.rows[0]).toMatchObject({
      actorEmail: "admin@example.com",
      action: "secret.reveal",
      target: "agent:my-bot",
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
      recordAudit({ actorEmail: "a@example.com", action: "agent.delete", target: "agent:p" }),
    ).resolves.toBeUndefined();
  });
});

/**
 * The no-op above is right for a script and wrong for a server, and only boot
 * can tell them apart.
 *
 * The awaited boot path is exercised for real in `instrumentationBoot.test.ts`:
 * `register()` is called and asserted to refuse when the push does not take.
 * What is left here is the predicate itself, and the *other* wiring site.
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

  it("is still wired by the composition root", () => {
    // A text check, and deliberately the weaker kind: importing `container.ts`
    // constructs every AWS client, which is the cost this covers rather than
    // pays. It guards the case `instrumentationBoot.test.ts` cannot reach — the
    // processes with no instrumentation hook, where the scripts and the
    // integration check compose the container and nothing else. A commented-out
    // call would satisfy it; a deleted one would not, and deletion is the way
    // this wiring has actually been at risk of going.
    expect(readFileSync(new URL("../src/lib/container.ts", import.meta.url), "utf8")).toContain(
      "setAuditSink(auditRepository)",
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
    expect((await useCases.list({ from: "2026-08-03" })).events).toHaveLength(1);
    expect((await useCases.list({ from: "2026-08-02" })).events).toHaveLength(0);
  });

  it("pages a busy audit day without collecting the entire partition", async () => {
    sink.rows.push(
      ...Array.from({ length: AUDIT_PAGE_SIZE * 2 + 2 }, (_, index) => ({
        eventId: `event-${String(index).padStart(3, "0")}`,
        actorEmail: "admin@example.com",
        action: "settings.update" as const,
        target: "settings:app",
        createdAt: "2026-08-03T10:00:00.000Z",
      })),
    );
    const listByDay = sink.listByDay.bind(sink);
    const pageSizes: number[] = [];
    sink.listByDay = async (day, limit, after) => {
      const page = await listByDay(day, limit, after);
      pageSizes.push(page.length);
      return page;
    };

    const first = await useCases.list({ from: "2026-08-03" });
    expect(first.events).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first.nextCursor).toBeTruthy();
    const second = await useCases.list({ from: "2026-08-03", cursor: first.nextCursor! });
    expect(second.events).toHaveLength(AUDIT_PAGE_SIZE);
    const third = await useCases.list({ from: "2026-08-03", cursor: second.nextCursor! });
    expect(third.events).toHaveLength(2);
    expect(third.nextCursor).toBeNull();
    expect([...first.events, ...second.events, ...third.events].map((event) => event.eventId))
      .toEqual([...sink.rows].reverse().map((event) => event.eventId));
    expect(pageSizes).toEqual([AUDIT_PAGE_SIZE + 1, AUDIT_PAGE_SIZE + 1, 2]);
  });

  it("continues across UTC day partitions without repeating a row", async () => {
    sink.rows.push(...["2026-08-03", "2026-08-02"].flatMap((day, dayIndex) =>
      Array.from({ length: dayIndex === 0 ? 2 : 3 }, (_, index) => ({
        eventId: `${day}-${index}`, actorEmail: "admin@example.com",
        action: "settings.update" as const, target: "settings:app", createdAt: `${day}T10:00:00.000Z`,
      }))));
    const first = await useCases.list({ from: "2026-08-02", to: "2026-08-03", limit: 3 });
    expect(first.events.map((event) => event.eventId)).toEqual(["2026-08-03-1", "2026-08-03-0", "2026-08-02-2"]);
    const second = await useCases.list({ from: "2026-08-02", to: "2026-08-03", limit: 3, cursor: first.nextCursor! });
    expect(second.events.map((event) => event.eventId)).toEqual(["2026-08-02-1", "2026-08-02-0"]);
    expect(second.nextCursor).toBeNull();
  });

  it("does not offer another page when the result exactly fills one page", async () => {
    sink.rows.push(...Array.from({ length: AUDIT_PAGE_SIZE }, (_, index) => ({
      eventId: `event-${index}`, actorEmail: "admin@example.com",
      action: "settings.update" as const, target: "settings:app", createdAt: "2026-08-03T10:00:00.000Z",
    })));
    const page = await useCases.list({ from: "2026-08-03" });
    expect(page.events).toHaveLength(AUDIT_PAGE_SIZE);
    expect(page.nextCursor).toBeNull();
  });

  it("rejects a cursor outside the requested range or with invalid encoding", async () => {
    sink.rows.push(...["e1", "e2"].map((eventId) => ({ eventId, actorEmail: "admin@example.com",
      action: "settings.update" as const, target: "settings:app", createdAt: "2026-08-03T10:00:00.000Z" })));
    const first = await useCases.list({ from: "2026-08-03", limit: 1 });
    await expect(useCases.list({ from: "2026-08-02", cursor: first.nextCursor! }))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(useCases.list({ from: "2026-08-03", cursor: "not-base64!" }))
      .rejects.toBeInstanceOf(ValidationError);
    const invalidTime = Buffer.from(JSON.stringify(["2026-08-03", "not-a-time", "e1"])).toString("base64url");
    await expect(useCases.list({ from: "2026-08-03", cursor: invalidTime }))
      .rejects.toBeInstanceOf(ValidationError);
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
    // `2026-13-01` has the right shape and parses to NaN, which would make the
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

  it("refuses an enormous range before querying any partition", async () => {
    const listByDay = vi.spyOn(sink, "listByDay");
    await expect(
      useCases.list({ from: "0001-01-01", to: "9999-12-31" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(listByDay).not.toHaveBeenCalled();
  });
});
