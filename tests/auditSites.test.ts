import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAuditSink } from "@/application/audit/recordAudit";
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
import { createSettingsUseCases } from "@/application/settings/settingsUseCases";
import { createTriggerUseCases } from "@/application/trigger/triggerUseCases";
import {
  REGISTRY_LIST_PAGE_SIZE,
  createRegistryUseCases,
} from "@/application/registry/registryUseCases";
import type { AuditEvent } from "@/domain/audit/types";
import type { AuditRepository } from "@/domain/audit/repository";
import type { Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings } from "@/domain/settings/types";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { Trigger, WebhookTrigger } from "@/domain/trigger/types";

/**
 * Every act the audit trail claims to cover, proved to leave a row.
 *
 * The gap this closes was uneven rather than total: reveals and the admin
 * override already wrote a log line, while a settings write and a deletion left
 * nothing at all — so "who changed the admin list, and when" had no answer, and
 * a deleted project took the row that would have named its owner.
 */

const OWNER = "owner@example.com";
const ADMIN = "admin@example.com";

let rows: AuditEvent[];

function sink(): AuditRepository {
  return {
    async append(event) {
      rows.push(event);
    },
    async listByDay() {
      return rows;
    },
  };
}

/** Identity cipher: these tests are about the record, not the encryption. */
const cipher = {
  encrypt: (v: string) => `enc:v1:${v}`,
  decrypt: (v: string) => v.replace(/^enc:v1:/, ""),
  mask: () => "****",
  isMasked: (v: string) => v === "****",
  decryptEquals: (stored: string, candidate: string) =>
    stored.replace(/^enc:v1:/, "") === candidate,
} as unknown as SecretCipher;

const project: Project = {
  name: "p",
  displayName: "P",
  description: "",
  ownerEmail: OWNER,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function projects(overrides: Partial<ProjectRepository> = {}): ProjectRepository {
  return {
    get: async () => project,
    list: async () => [project],
    create: async () => {},
    update: async () => {},
    delete: async () => {},
    getApiToken: async () => ({
      token: "enc:v1:tok_secret",
      masked: "****",
      createdAt: "2026-01-01T00:00:00Z",
    }),
    setApiToken: async () => {},
    deleteApiToken: async () => {},
    ...overrides,
  };
}

const actions = () => rows.map((row) => row.action);

beforeEach(() => {
  rows = [];
  setAuditSink(sink());
  setAdminCheck(async () => false);
});

afterEach(() => {
  setAuditSink(undefined);
  setAdminCheck(async () => false);
});

describe("project acts", () => {
  it("records an admin writing a project owned by someone else", async () => {
    setAdminCheck(async (email) => email === ADMIN);
    await assertProjectWritable(projects(), "p", ADMIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorEmail: ADMIN,
      action: "project.admin-override",
      target: "project:p",
      detail: `owned by ${OWNER}`,
    });
  });

  it("records nothing when the owner writes their own project", async () => {
    await assertProjectWritable(projects(), "p", OWNER);
    expect(rows).toHaveLength(0);
  });

  it("records a deletion, with the owner the cascade is about to erase", async () => {
    await deleteProject(projects(), "p", OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "project.delete",
      target: "project:p",
      detail: `owned by ${OWNER}`,
    });
  });

  it("still deletes when the pre-delete hook fails — nothing may make a project undeletable", async () => {
    const repo = projects();
    let deleted = false;
    repo.delete = async () => {
      deleted = true;
    };
    await deleteProject(repo, "p", OWNER, async () => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    expect(deleted).toBe(true);
    expect(actions()).toEqual(["project.delete"]);
  });
});

describe("project API token", () => {
  it("records issuing one", async () => {
    await generateApiToken(projects(), "p", OWNER, cipher);
    expect(actions()).toEqual(["secret.rotate"]);
  });

  it("records revealing one", async () => {
    await revealApiToken(projects(), "p", OWNER, cipher);
    expect(rows[0]).toMatchObject({ action: "secret.reveal", target: "project:p" });
  });

  it("records revoking one", async () => {
    await revokeApiToken(projects(), "p", OWNER);
    expect(actions()).toEqual(["secret.revoke"]);
  });

  it("records the override *and* the reveal when an admin reads someone else's token", async () => {
    // The token authenticates as the owner, so this is an admin taking a
    // credential that acts in another person's name. One row would not say that.
    setAdminCheck(async (email) => email === ADMIN);
    await revealApiToken(projects(), "p", ADMIN, cipher);
    expect(actions()).toEqual(["project.admin-override", "secret.reveal"]);
  });
});

describe("app settings", () => {
  function useCases(stored: AppSettings | null = null) {
    let current = stored;
    const repo: SettingsRepository = {
      get: async () => current,
      update: async (mutate) => {
        const before = current;
        const after = mutate(current);
        current = after;
        return { before, after };
      },
    };
    return createSettingsUseCases(repo, cipher, {} as NodeJS.ProcessEnv, () => []);
  }

  it("records which keys were written, and never their values", async () => {
    await useCases().update({ llmApiKey: "sk-live-secret", pluginsRepo: "org/plugins" }, ADMIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorEmail: ADMIN,
      action: "settings.update",
      target: "settings:app",
    });
    expect(rows[0]?.detail).toContain("llmApiKey");
    expect(rows[0]?.detail).toContain("pluginsRepo");
    // The row is the record of who moved a credential, not a copy of it.
    expect(JSON.stringify(rows[0])).not.toContain("sk-live-secret");
  });

  it("records a rejected write not at all", async () => {
    await expect(useCases().update({ adminEmails: " , " }, ADMIN)).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });

  it("names what changed, not what the form submitted", async () => {
    // The settings page posts all ten fields on every save. Keys-carried made
    // the detail a constant listing them all, which says only "the form was
    // saved" — and "who changed the admin list last quarter" then has no answer.
    const cases = useCases();
    await cases.update({ pluginsRepo: "org/plugins", pluginsRepoBranch: "next" }, ADMIN);
    rows = [];
    await cases.update({ pluginsRepo: "org/plugins", pluginsRepoBranch: "other" }, ADMIN);
    expect(rows[0]?.detail).toBe("pluginsRepoBranch");
  });

  it("says so when a save moved nothing", async () => {
    const cases = useCases();
    await cases.update({ pluginsRepo: "org/plugins" }, ADMIN);
    rows = [];
    await cases.update({ pluginsRepo: "org/plugins" }, ADMIN);
    expect(rows[0]?.detail).toBe("no fields changed");
  });

  it("does not report a resubmitted masked secret as a change", async () => {
    // A mask can only confirm a secret. The write keeps the stored value, so the
    // row must not claim the credential moved.
    const cases = useCases();
    await cases.update({ llmApiKey: "sk-live" }, ADMIN);
    rows = [];
    await cases.update({ llmApiKey: "****", pluginsRepo: "org/plugins" }, ADMIN);
    expect(rows[0]?.detail).toBe("pluginsRepo");
  });
});

describe("webhook trigger secrets", () => {
  const webhook: WebhookTrigger = {
    projectName: "p",
    triggerId: "inbound",
    kind: "webhook",
    description: "",
    enabled: true,
    secret: "enc:v1:whsec",
    allowConcurrent: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  function useCases(stored: Trigger = webhook) {
    const triggers: TriggerRepository = {
      get: async () => stored,
      listByProject: async () => [stored],
      listSchedules: async () => [],
      create: async () => {},
      put: async () => {},
      delete: async () => {},
      claimIdempotencyKey: async () => true,
      appendRun: async () => {},
      finishRun: async () => {},
      updateQueuedRun: async () => { throw new Error("CRUD does not dispatch queued runs"); },
      listRuns: async () => [],
    };
    return createTriggerUseCases({ triggers, projects: projects(), cipher });
  }

  it("records a reveal", async () => {
    await useCases().reveal("p", "inbound", OWNER);
    expect(rows[0]).toMatchObject({ action: "secret.reveal", target: "project:p" });
    expect(rows[0]?.detail).toContain("inbound");
  });

  it("records a rotation", async () => {
    await useCases().update("p", "inbound", { rotateSecret: true }, OWNER);
    expect(actions()).toEqual(["secret.rotate"]);
  });

  it("records nothing for an update that did not rotate", async () => {
    await useCases().update("p", "inbound", { description: "renamed" }, OWNER);
    expect(rows).toHaveLength(0);
  });

  it("records a deletion", async () => {
    await useCases().remove("p", "inbound", OWNER);
    expect(actions()).toEqual(["secret.revoke"]);
  });

  it("records a schedule deletion as no revocation, because there was no secret", async () => {
    // `secret.revoke` means "a credential was removed". A schedule has none —
    // revealing one is refused for that exact reason — and filing its deletion
    // under the action an auditor filters on to enumerate credential removals
    // makes that filter untrustworthy.
    const schedule: Trigger = {
      projectName: "p",
      triggerId: "nightly",
      kind: "schedule",
      description: "",
      enabled: true,
      cron: "0 9 * * *",
      timezone: "Asia/Seoul",
      allowConcurrent: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await useCases(schedule).remove("p", "nightly", OWNER);
    expect(rows).toHaveLength(0);
  });
});

describe("shared registry entries", () => {
  it("reads the complete registry through bounded name-key pages", async () => {
    const entries = Array.from({ length: REGISTRY_LIST_PAGE_SIZE + 2 }, (_, index) => ({
      name: `entry-${String(index).padStart(3, "0")}`,
    }));
    const pageSizes: number[] = [];
    const useCases = createRegistryUseCases<
      (typeof entries)[number],
      (typeof entries)[number],
      object
    >({
      label: "Skill",
      auditKind: "skill",
      repo: {
        get: async () => null,
        list: async (limit, after) => {
          const page = entries.filter((entry) => !after || entry.name > after).slice(0, limit);
          pageSizes.push(page.length);
          return page;
        },
        create: async () => {},
        update: async () => {},
        delete: async () => {},
      },
      build: (input) => input,
      apply: (existing) => existing,
    });

    await expect(useCases.list()).resolves.toHaveLength(entries.length);
    expect(pageSizes).toEqual([REGISTRY_LIST_PAGE_SIZE, 2]);
  });

  it("records a deletion against the kind that was deleted", async () => {
    const entry = { name: "pdf-reader" };
    const useCases = createRegistryUseCases<typeof entry, typeof entry, object>({
      label: "Skill",
      auditKind: "skill",
      repo: {
        get: async () => entry,
        list: async () => [entry],
        create: async () => {},
        update: async () => {},
        delete: async () => {},
      },
      build: (input) => input,
      apply: (existing) => existing,
    });
    await useCases.remove("pdf-reader", ADMIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorEmail: ADMIN,
      action: "registry.delete",
      target: "skill:pdf-reader",
    });
  });
});
