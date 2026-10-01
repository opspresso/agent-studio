import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuditSink } from "@/application/audit/recordAudit";
import {
  assertAgentWritable,
  deleteAgent,
  setAdminCheck,
} from "@/application/agent/agentUseCases";
import { createApiTokenUseCases } from "@/application/agent/apiTokenUseCases";
import type { ApiToken } from "@/domain/auth/apiToken";
import { createSettingsUseCases } from "@/application/settings/settingsUseCases";
import { createArtifactUseCases } from "@/application/artifact/artifactUseCases";
import { listAgentTraces } from "@/application/trace/traceUseCases";
import { listAgentActorsFor } from "@/application/usage/usageUseCases";
import { getAgentSlack } from "@/application/slack/agentSlack";
import { getAgentTelegram } from "@/application/telegram/agentTelegram";
import { getAgentTeams } from "@/application/teams/agentTeams";
import { createMcpAuthUseCases } from "@/application/mcp/mcpAuthUseCases";
import { createTriggerUseCases } from "@/application/trigger/triggerUseCases";
import {
  REGISTRY_LIST_PAGE_SIZE,
  createRegistryUseCases,
} from "@/application/registry/registryUseCases";
import type { AuditEvent } from "@/domain/audit/types";
import type { AuditRepository } from "@/domain/audit/repository";
import type { Agent } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings } from "@/domain/settings/types";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { Trigger, WebhookTrigger } from "@/domain/trigger/types";

/** Audit-covered mutations leave a row; reads and unchanged secrets do not. */

const ids = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++ids.sequence).padStart(12, "0")}`,
  randomBytes: (size: number) => {
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(++ids.sequence);
    return bytes;
  },
}));

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

const agent: Agent = {
  name: "p",
  displayName: "P",
  description: "",
  ownerEmail: OWNER,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function agents(overrides: Partial<AgentRepository> = {}): AgentRepository {
  return {
    get: async () => agent,
    list: async () => [agent],
    create: async () => {},
    update: async () => {},
    delete: async () => {},
    ...overrides,
  };
}

const actions = () => rows.map((row) => row.action);

beforeEach(() => {
  ids.sequence = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-01-02T00:00:00.000Z");
  rows = [];
  setAuditSink(sink());
  setAdminCheck(async () => false);
});

afterEach(() => {
  vi.useRealTimers();
  setAuditSink(undefined);
  setAdminCheck(async () => false);
});

describe("agent acts", () => {
  it("does not record a write override for owner-scoped reads", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    setAdminCheck(async (email) => email === ADMIN);
    const repo = agents();
    await listAgentTraces({ agents: repo, traces: { listByAgent: async () => [] } as never }, "p", ADMIN);
    await listAgentActorsFor({ agents: repo, usage: { listActorsByAgent: async () => [] } as never,
      profileReaderFor: () => null }, "p", ADMIN, "2026-01-01", "2026-01-31");
    await createArtifactUseCases({ listByAgent: async () => [] } as never, {} as never, repo)
      .listByAgent("p", ADMIN);
    await personalTokens(repo).status("p", "admin");
    await getAgentSlack(repo, "p", ADMIN, cipher);
    await getAgentTelegram(repo, "p", ADMIN, cipher);
    await getAgentTeams(repo, "p", ADMIN, cipher);
    await createMcpAuthUseCases({ agents: repo, connections: { listByAgent: async () => [] },
      lifecycleClaims: new Set() } as never).listConnections("p", ADMIN);
    warned.mockRestore();
    expect(rows).toEqual([]);
  });

  it("records an admin writing an agent owned by someone else", async () => {
    setAdminCheck(async (email) => email === ADMIN);
    await assertAgentWritable(agents(), "p", ADMIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorEmail: ADMIN,
      action: "agent.admin-override",
      target: "agent:p",
      detail: `owned by ${OWNER}`,
    });
  });

  it("records nothing when the owner writes their own agent", async () => {
    await assertAgentWritable(agents(), "p", OWNER);
    expect(rows).toHaveLength(0);
  });

  it("records a deletion, with the owner the cascade is about to erase", async () => {
    await deleteAgent(agents(), "p", OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "agent.delete",
      target: "agent:p",
      detail: `owned by ${OWNER}`,
    });
  });

  it("still deletes when the pre-delete hook fails — nothing may make an agent undeletable", async () => {
    const repo = agents();
    let deleted = false;
    repo.delete = async () => {
      deleted = true;
    };
    await deleteAgent(repo, "p", OWNER, async () => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    expect(deleted).toBe(true);
    expect(actions()).toEqual(["agent.delete"]);
  });
});

function personalTokens(repo = agents()) {
  const records = new Map<string, ApiToken>();
  records.set("owner", { id: "00000000-0000-4000-8000-000000000001", agentName: "p", userId: "owner", token: "enc:v1:own-token", masked: "****", createdAt: "2026-01-01" });
  records.set("admin", { id: "00000000-0000-4000-8000-000000000002", agentName: "p", userId: "admin", token: "enc:v1:admin-token", masked: "****", createdAt: "2026-01-01" });
  return createApiTokenUseCases({ agents: repo, cipher, now: () => new Date(), newId: () => "00000000-0000-4000-8000-000000000003",
    members: { getById: async id => ({ id, email: id === "admin" ? ADMIN : OWNER, name: id, tier: "member", image: null, joinedAt: "2026-01-01", lastLoginAt: "2026-01-01" }) },
    tokens: { get: async (_name, id) => [...records.values()].find(row => row.id === id) ?? null, forUser: async (_name, id) => records.get(id) ?? null,
      replace: async token => { records.set(token.userId, token); }, revoke: async (_name, id) => { records.delete(id); } } });
}
describe("personal API token audit", () => {
  it("records personal issuance", async () => {
    await personalTokens().generate("p", "owner");
    expect(rows).toMatchObject([{ action: "secret.rotate", actorEmail: OWNER }]);
  });
  it("records revealing one's own token", async () => {
    await personalTokens().reveal("p", "owner");
    expect(rows[0]).toMatchObject({ action: "secret.reveal", target: "agent:p", actorEmail: OWNER });
  });
  it("records personal revocation", async () => {
    await personalTokens().revoke("p", "owner");
    expect(rows[0]).toMatchObject({ action: "secret.revoke", actorEmail: OWNER });
  });
  it("records an administrator's own credential without impersonating the Agent owner", async () => {
    setAdminCheck(async email => email === ADMIN);
    await personalTokens().reveal("p", "admin");
    expect(actions()).toEqual(["secret.reveal"]);
    expect(rows[0]?.actorEmail).toBe(ADMIN);
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
    return createSettingsUseCases(repo, cipher, {} as NodeJS.ProcessEnv, () => [], ["agent-studio"]);
  }

  it("records which keys were written, and never their values", async () => {
    await useCases().update({ githubToken: "gh-live-secret", pluginsRepo: "org/plugins" }, ADMIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorEmail: ADMIN,
      action: "settings.update",
      target: "settings:app",
    });
    expect(rows[0]?.detail).toContain("githubToken");
    expect(rows[0]?.detail).toContain("pluginsRepo");
    // The row is the record of who moved a credential, not a copy of it.
    expect(JSON.stringify(rows[0])).not.toContain("gh-live-secret");
  });

  it("records a rejected write not at all", async () => {
    await expect(useCases().update({ adminEmails: " , " }, ADMIN)).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });

  it("names what changed, not what the form submitted", async () => {
    // A full form submission records only fields whose effective values changed.
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
    await cases.update({ githubToken: "gh-live" }, ADMIN);
    rows = [];
    await cases.update({ githubToken: "****", pluginsRepo: "org/plugins" }, ADMIN);
    expect(rows[0]?.detail).toBe("pluginsRepo");
  });
});

describe("webhook trigger secrets", () => {
  const webhook: WebhookTrigger = {
    agentName: "p",
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
      listByAgent: async () => [stored],
      listSchedules: async () => [],
      create: async () => {},
      put: async () => {},
      delete: async () => {},
      claimIdempotencyKey: async () => true,
      appendRun: async () => {},
      finishRun: async () => {},
      updateQueuedRun: async () => { throw new Error("CRUD does not dispatch queued runs"); },
      updateRunningRun: async () => { throw new Error("CRUD does not dispatch running executions"); },
      listRuns: async () => [],
    };
    return createTriggerUseCases({ members: { getById: async () => null }, triggers, agents: agents(), cipher });
  }

  it("does not record a write override for an admin listing triggers or runs", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    setAdminCheck(async (email) => email === ADMIN);
    await useCases().list("p", ADMIN);
    await useCases().runs("p", "inbound", 10, ADMIN);
    warned.mockRestore();
    expect(rows).toEqual([]);
  });

  it("records a reveal", async () => {
    await useCases().reveal("p", "inbound", OWNER);
    expect(rows[0]).toMatchObject({ action: "secret.reveal", target: "agent:p" });
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
      agentName: "p",
      triggerId: "nightly",
      kind: "schedule", createdBy: { userId: "registrar-id", email: "registrar@example.test" },
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
