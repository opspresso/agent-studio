import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "@/domain/audit/types";
import type { AuditRepository } from "@/domain/audit/repository";
import type { Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { recordAudit, setAuditSink } from "@/application/audit/auditLog";
import {
  listAuditEvents,
  MAX_AUDIT_EVENTS,
  MAX_AUDIT_RANGE_DAYS,
} from "@/application/audit/listAuditEvents";
import { ValidationError } from "@/application/errors";
import {
  assertProjectWritable,
  deleteProject,
  setAdminCheck,
} from "@/application/project/projectUseCases";
import {
  generateApiToken,
  revealApiToken,
  revokeApiToken,
} from "@/application/project/apiTokenUseCases";

const recorded: AuditEvent[] = [];

beforeEach(() => {
  recorded.length = 0;
  setAuditSink(async (event) => {
    recorded.push(event);
  });
  setAdminCheck(async () => false);
});

afterEach(() => {
  setAdminCheck(async () => false);
});

const project: Project = {
  name: "bot",
  displayName: "Bot",
  description: "",
  projectType: "agent",
  ownerEmail: "owner@x.com",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Enough of the cipher for the token paths; masking and crypto have own tests. */
const cipher = {
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ""),
  mask: () => "ast_••••",
  isMasked: () => false,
  decryptEquals: () => false,
} as unknown as SecretCipher;

function projectRepo(token?: { token?: string; createdAt: string }): ProjectRepository {
  let stored = token;
  return {
    get: async () => project,
    list: async () => [project],
    create: async () => {},
    update: async () => {},
    publish: async () => {},
    delete: async () => {},
    getApiToken: async () => stored ?? null,
    setApiToken: async (_name: string, value: { token?: string; createdAt: string }) => {
      stored = value;
    },
    deleteApiToken: async () => {
      stored = undefined;
    },
  } as unknown as ProjectRepository;
}

describe("recordAudit", () => {
  it("stamps an id and a timestamp the record point does not supply", async () => {
    await recordAudit(
      { action: "settings.update", actorEmail: "admin@x.com", target: "settings:app" },
      new Date("2026-08-01T10:00:00.000Z"),
    );
    expect(recorded[0]).toMatchObject({
      action: "settings.update",
      actorEmail: "admin@x.com",
      target: "settings:app",
      createdAt: "2026-08-01T10:00:00.000Z",
    });
    expect(recorded[0]?.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("never lets a failed write break the act it was recording", async () => {
    setAuditSink(async () => {
      throw new Error("table unavailable");
    });
    await expect(
      recordAudit({ action: "secret.reveal", actorEmail: "a@x.com", target: "settings:a2a-key" }),
    ).resolves.toBeUndefined();
  });

  it("bounds the detail so one caller's error text cannot make a row unwritable", async () => {
    await recordAudit({
      action: "project.delete",
      actorEmail: "a@x.com",
      target: "project:bot",
      detail: "x".repeat(5_000),
    });
    expect(recorded[0]?.detail?.length).toBe(1_000);
  });
});

describe("record points", () => {
  it("records an admin writing a project owned by someone else", async () => {
    setAdminCheck(async () => true);
    await assertProjectWritable(projectRepo(), "bot", "admin@x.com");
    expect(recorded).toEqual([
      expect.objectContaining({
        action: "authz.admin-override",
        actorEmail: "admin@x.com",
        target: "project:bot",
        detail: "owned by owner@x.com",
      }),
    ]);
  });

  it("records nothing when the owner writes their own project", async () => {
    await assertProjectWritable(projectRepo(), "bot", "owner@x.com");
    expect(recorded).toEqual([]);
  });

  it("records a project deletion, naming the owner the row took away", async () => {
    await deleteProject(projectRepo(), "bot", "owner@x.com");
    expect(recorded).toEqual([
      expect.objectContaining({
        action: "project.delete",
        target: "project:bot",
        detail: "owned by owner@x.com",
      }),
    ]);
  });

  it("records issuing, revealing and revoking a project API token", async () => {
    const repo = projectRepo();
    await generateApiToken(repo, "bot", "owner@x.com", cipher);
    await revealApiToken(repo, "bot", "owner@x.com", cipher);
    await revokeApiToken(repo, "bot", "owner@x.com");

    expect(recorded.map((event) => event.action)).toEqual([
      "secret.issue",
      "secret.reveal",
      "secret.revoke",
    ]);
    expect(new Set(recorded.map((event) => event.target))).toEqual(
      new Set(["project:bot/api-token"]),
    );
  });

  it("never carries the secret it is recording", async () => {
    const repo = projectRepo();
    const { token } = await generateApiToken(repo, "bot", "owner@x.com", cipher);
    await revealApiToken(repo, "bot", "owner@x.com", cipher);
    expect(JSON.stringify(recorded)).not.toContain(token);
  });
});

describe("listAuditEvents", () => {
  const events: Record<string, AuditEvent[]> = {
    "2026-08-01": [
      {
        id: "a",
        action: "secret.reveal",
        actorEmail: "a@x.com",
        target: "settings:a2a-key",
        createdAt: "2026-08-01T09:00:00.000Z",
      },
    ],
    "2026-08-02": [
      {
        id: "b",
        action: "settings.update",
        actorEmail: "b@x.com",
        target: "settings:app",
        createdAt: "2026-08-02T09:00:00.000Z",
      },
    ],
  };
  const repo: AuditRepository = {
    append: async () => {},
    listByDay: async (day) => events[day] ?? [],
  };

  it("assembles a range from its day partitions, newest first", async () => {
    const result = await listAuditEvents(repo, { from: "2026-08-01", to: "2026-08-03" });
    expect(result.events.map((event) => event.id)).toEqual(["b", "a"]);
    expect(result.truncated).toBe(false);
  });

  it("caps what one read returns, and says the oldest end was dropped", async () => {
    // The range bound limits how many partitions are read, not how large one
    // is — and nothing bounds a partition: a row is written on every reveal,
    // settings write and deletion, kept for a year. A page that stops at the
    // cap without saying so reads as a range that ended there.
    const many: AuditRepository = {
      append: async () => {},
      listByDay: async (day) =>
        day === "2026-08-01"
          ? Array.from({ length: MAX_AUDIT_EVENTS + 5 }, (_, index) => ({
              id: `e${index}`,
              action: "secret.reveal" as const,
              actorEmail: "a@x.com",
              target: "settings:a2a-key",
              // Descending, so the newest are the ones kept.
              createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
            }))
          : [],
    };
    const result = await listAuditEvents(many, { from: "2026-08-01", to: "2026-08-01" });
    expect(result.events).toHaveLength(MAX_AUDIT_EVENTS);
    expect(result.truncated).toBe(true);
    expect(result.events[0]?.id).toBe(`e${MAX_AUDIT_EVENTS + 4}`);
  });

  it("asks each day partition for no more than the read will return", async () => {
    // Otherwise the cap is a slice: every row of every day is read and held
    // before 99% of them are discarded, which is the cost the bound was
    // supposed to be about.
    const asked: (number | undefined)[] = [];
    const recording: AuditRepository = {
      append: async () => {},
      listByDay: async (day, limit) => {
        asked.push(limit);
        return events[day] ?? [];
      },
    };
    await listAuditEvents(recording, { from: "2026-08-01", to: "2026-08-02" });
    expect(asked).toEqual([MAX_AUDIT_EVENTS, MAX_AUDIT_EVENTS]);
  });

  it("calls a day that came back full truncated, even when the range fits", async () => {
    // The assembled range is exactly the cap, so a length test alone would
    // report a complete answer for one that is missing that day's older rows.
    const full: AuditRepository = {
      append: async () => {},
      listByDay: async (day, limit) =>
        day === "2026-08-01"
          ? Array.from({ length: limit ?? 0 }, (_, index) => ({
              id: `e${index}`,
              action: "secret.reveal" as const,
              actorEmail: "a@x.com",
              target: "settings:a2a-key",
              createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
            }))
          : [],
    };
    const result = await listAuditEvents(full, { from: "2026-08-01", to: "2026-08-01" });
    expect(result.events).toHaveLength(MAX_AUDIT_EVENTS);
    expect(result.truncated).toBe(true);
  });

  it("refuses a range wider than the day fan-out it would cost", async () => {
    await expect(listAuditEvents(repo, { from: "2026-01-01", to: "2026-12-31" })).rejects.toThrow(
      new RegExp(`${MAX_AUDIT_RANGE_DAYS} days`),
    );
  });

  it("refuses a backwards or unparseable range", async () => {
    await expect(
      listAuditEvents(repo, { from: "2026-08-03", to: "2026-08-01" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(listAuditEvents(repo, { from: "yesterday", to: "today" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
