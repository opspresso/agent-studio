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
import { createRegistryUseCases } from "@/application/registry/registryUseCases";
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
  projectType: "agent",
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
    publish: async () => {},
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
      put: async (next) => {
        current = next;
      },
    };
    return createSettingsUseCases(repo, cipher, {} as NodeJS.ProcessEnv, () => []);
  }

  it("records which keys were written, and never their values", async () => {
    await useCases().update({ llmApiKey: "sk-live-secret", toolsRepo: "org/tools" }, ADMIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorEmail: ADMIN,
      action: "settings.update",
      target: "settings:app",
    });
    expect(rows[0]?.detail).toContain("llmApiKey");
    expect(rows[0]?.detail).toContain("toolsRepo");
    // The row is the record of who moved a credential, not a copy of it.
    expect(JSON.stringify(rows[0])).not.toContain("sk-live-secret");
  });

  it("records a rejected write not at all", async () => {
    await expect(useCases().update({ adminEmails: " , " }, ADMIN)).rejects.toThrow();
    expect(rows).toHaveLength(0);
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
    payloadMode: "message",
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
});

describe("shared registry entries", () => {
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
