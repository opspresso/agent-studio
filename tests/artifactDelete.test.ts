import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactUseCases } from "@/application/artifact/artifactUseCases";
import { setAuditSink } from "@/application/audit/recordAudit";
import { setAdminCheck } from "@/application/agent/agentUseCases";
import { NotFoundError } from "@/application/errors";
import type { AuditEvent } from "@/domain/audit/types";
import type { Artifact } from "@/domain/artifact/types";
import type { Agent } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";

const OWNER = "owner@x.com";
const OTHER = "other@x.com";
const ADMIN = "admin@x.com";

const agent: Agent = {
  name: "poster-bot",
  displayName: "Poster",
  description: "",
  ownerEmail: OWNER,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: "a1",
    kind: "image",
    source: "generated",
    key: "artifacts/image/a1.png",
    mimeType: "image/png",
    byteSize: 100,
    agentName: "poster-bot",
    actor: { kind: "user", id: OWNER },
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

const agents: AgentRepository = {
  async get(name) {
    return name === agent.name ? agent : null;
  },
  async list() {
    return [agent];
  },
  async create() {},
  async update() {},
  async delete() {},
  async getApiToken() {
    return null;
  },
  async setApiToken() {},
  async deleteApiToken() {},
};

function setup(stored: Artifact | null, over: { rowDeleteFails?: boolean } = {}) {
  const calls: string[] = [];
  let current = stored;
  const rows = {
    async put() {},
    async get(id: string) {
      return current && current.artifactId === id ? current : null;
    },
    async listByAgent() {
      return [];
    },
    async listByOwner() {
      return [];
    },
    async delete() {
      calls.push("row.delete");
      if (over.rowDeleteFails) {
        throw new Error("dynamo down");
      }
      current = null;
    },
  };
  const objects = {
    async put() {},
    async read() {
      return { bytes: new Uint8Array(), mimeType: "application/octet-stream" };
    },
    async sign(key: string) {
      return `https://signed/${key}`;
    },
    async delete() {
      // S3 answers 204 for a key that is not there, which is what makes the
      // whole operation idempotent.
      calls.push("object.delete");
    },
  };
  const useCases = createArtifactUseCases(rows, objects, agents);
  return { useCases, calls, present: () => current !== null };
}

const audited: AuditEvent[] = [];

beforeEach(() => {
  audited.length = 0;
  setAuditSink({
    async append(event) {
      audited.push(event);
    },
    async listByDay() {
      return [];
    },
  });
  setAdminCheck(async (email) => email === ADMIN);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("deleting an artifact", () => {
  it("removes the object before the row", async () => {
    // The reverse order can only fail one way: the row is gone and the bytes
    // remain, with nothing left that names the key — permanently unreachable.
    // This order fails to a broken preview, which pressing delete again fixes.
    const { useCases, calls } = setup(artifact());
    await useCases.remove("a1", OWNER);
    expect(calls).toEqual(["object.delete", "row.delete"]);
  });

  it("converges when a retry follows a half-finished delete", async () => {
    const { useCases, calls } = setup(artifact(), { rowDeleteFails: true });
    await expect(useCases.remove("a1", OWNER)).rejects.toThrow("dynamo down");
    // The object is already gone; the second attempt must not trip over that.
    const retry = setup(artifact());
    await retry.useCases.remove("a1", OWNER);
    expect(retry.present()).toBe(false);
    expect(calls).toEqual(["object.delete", "row.delete"]);
  });

  it("refuses an artifact that is not there", async () => {
    const { useCases } = setup(null);
    await expect(useCases.remove("missing", OWNER)).rejects.toThrow(NotFoundError);
  });
});

describe("who may delete", () => {
  it("lets the person whose run made it", async () => {
    const { useCases, present } = setup(artifact());
    await useCases.remove("a1", OWNER);
    expect(present()).toBe(false);
  });

  it("lets the agent owner remove what a Slack run produced", async () => {
    // The whole reason the agent axis exists: this row names no mailbox, so
    // nobody could reach it through a personal gallery.
    const { useCases, present } = setup(artifact({ actor: { kind: "slack", id: "U1" } }));
    await useCases.remove("a1", OWNER);
    expect(present()).toBe(false);
  });

  it("lets an admin reach into another agent", async () => {
    const { useCases, present } = setup(artifact({ actor: { kind: "user", id: OTHER } }));
    await useCases.remove("a1", ADMIN);
    expect(present()).toBe(false);
  });

  it("refuses a stranger", async () => {
    const { useCases, present } = setup(artifact());
    await expect(useCases.remove("a1", OTHER)).rejects.toThrow();
    expect(present()).toBe(true);
  });
});

describe("what is recorded", () => {
  it("records reaching into someone else's output", async () => {
    const { useCases } = setup(artifact({ actor: { kind: "user", id: OTHER } }));
    await useCases.remove("a1", ADMIN);
    const deletion = audited.find((event) => event.action === "artifact.delete");
    expect(deletion).toMatchObject({ actorEmail: ADMIN, target: "artifact:a1" });
    // Never the prompt or the bytes — a trail row is not a copy of the content.
    expect(deletion?.detail).toBe("image in agent poster-bot");
  });

  it("stays quiet when a person tidies up their own gallery", async () => {
    // A row per deletion would bury the acts this trail exists for.
    const { useCases } = setup(artifact());
    await useCases.remove("a1", OWNER);
    expect(audited.filter((event) => event.action === "artifact.delete")).toHaveLength(0);
  });

  it("records the admin override on the way through", async () => {
    const { useCases } = setup(artifact({ actor: { kind: "slack", id: "U1" } }));
    await useCases.remove("a1", ADMIN);
    expect(audited.map((event) => event.action)).toContain("agent.admin-override");
  });
});

describe("listing", () => {
  it("checks the agent before handing over its artifacts", async () => {
    const { useCases } = setup(artifact());
    await expect(useCases.listByAgent("poster-bot", OTHER)).rejects.toThrow();
    await expect(useCases.listByAgent("poster-bot", OWNER)).resolves.toEqual([]);
  });

  it("bounds a page however much a caller asks for", async () => {
    const seen: number[] = [];
    const rows = {
      async put() {},
      async get() {
        return null;
      },
      async listByAgent() {
        return [];
      },
      async listByOwner(_email: string, options?: { limit?: number }) {
        seen.push(options?.limit ?? -1);
        return [];
      },
      async delete() {},
    };
    const useCases = createArtifactUseCases(
      rows,
      {
        async put() {},
        async read() {
          return { bytes: new Uint8Array(), mimeType: "application/octet-stream" };
        },
        async sign() {
          return "";
        },
        async delete() {},
      },
      agents,
    );
    await useCases.listMine(OWNER, { limit: 5000 });
    await useCases.listMine(OWNER, { limit: 0 });
    await useCases.listMine(OWNER);
    expect(seen).toEqual([100, 1, 24]);
  });
});
