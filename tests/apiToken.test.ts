import { describe, expect, it } from "vitest";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project, ProjectApiToken } from "@/domain/project/types";
import {
  generateApiToken,
  getApiTokenStatus,
  revokeApiToken,
  verifyProjectApiToken,
} from "@/application/project/apiTokenUseCases";
import {
  apiTokenHashEquals,
  generateApiTokenValue,
  hashApiToken,
} from "@/lib/apiToken";
import { ForbiddenError } from "@/application/errors";

const OWNER = "owner@example.com";

function project(): Project {
  return {
    name: "my-bot",
    displayName: "My Bot",
    description: "",
    projectType: "agent",
    ownerEmail: OWNER,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeRepo(p: Project | null): {
  repo: ProjectRepository;
  stored: () => ProjectApiToken | null;
} {
  let token: ProjectApiToken | null = null;
  const repo: ProjectRepository = {
    async get(name) {
      return p && p.name === name ? p : null;
    },
    async list() {
      return p ? [p] : [];
    },
    async create() {},
    async update() {},
    async publish() {},
    async delete() {},
    async getApiToken() {
      return token;
    },
    async setApiToken(_name, t) {
      token = t;
    },
    async deleteApiToken() {
      token = null;
    },
  };
  return { repo, stored: () => token };
}

describe("apiToken crypto helpers", () => {
  it("generates prefixed, unique token values", () => {
    const a = generateApiTokenValue();
    const b = generateApiTokenValue();
    expect(a.startsWith("sk_proj_")).toBe(true);
    expect(a).not.toEqual(b);
  });

  it("hashes deterministically and compares in constant time", () => {
    const token = "sk_proj_abc";
    expect(hashApiToken(token)).toEqual(hashApiToken(token));
    expect(apiTokenHashEquals(hashApiToken(token), hashApiToken(token))).toBe(true);
    expect(apiTokenHashEquals(hashApiToken("a"), hashApiToken("b"))).toBe(false);
  });
});

describe("generateApiToken", () => {
  it("returns the raw token and stores only its hash", async () => {
    const { repo, stored } = makeRepo(project());
    const { token, createdAt } = await generateApiToken(repo, "my-bot", OWNER);

    expect(token.startsWith("sk_proj_")).toBe(true);
    expect(createdAt).toBeTruthy();
    // Only the hash is persisted — never the raw value.
    expect(stored()?.tokenHash).toBe(hashApiToken(token));
    expect(stored()?.tokenHash).not.toBe(token);
  });

  it("regeneration overwrites the previous token", async () => {
    const { repo } = makeRepo(project());
    const first = await generateApiToken(repo, "my-bot", OWNER);
    const second = await generateApiToken(repo, "my-bot", OWNER);
    expect(first.token).not.toEqual(second.token);
    // The old token no longer verifies; the new one does.
    expect(await verifyProjectApiToken(repo, "my-bot", first.token)).toBeNull();
    expect(await verifyProjectApiToken(repo, "my-bot", second.token)).toBe(OWNER);
  });

  it("rejects a non-owner", async () => {
    const { repo, stored } = makeRepo(project());
    await expect(generateApiToken(repo, "my-bot", "other@example.com")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(stored()).toBeNull();
  });
});

describe("verifyProjectApiToken", () => {
  it("returns the owner email for a valid token", async () => {
    const { repo } = makeRepo(project());
    const { token } = await generateApiToken(repo, "my-bot", OWNER);
    expect(await verifyProjectApiToken(repo, "my-bot", token)).toBe(OWNER);
  });

  it("returns null for a wrong token", async () => {
    const { repo } = makeRepo(project());
    await generateApiToken(repo, "my-bot", OWNER);
    expect(await verifyProjectApiToken(repo, "my-bot", "sk_proj_wrong")).toBeNull();
  });

  it("returns null when no token is configured", async () => {
    const { repo } = makeRepo(project());
    expect(await verifyProjectApiToken(repo, "my-bot", "sk_proj_anything")).toBeNull();
  });
});

describe("getApiTokenStatus / revokeApiToken", () => {
  it("reports configured state and revokes", async () => {
    const { repo } = makeRepo(project());
    expect(await getApiTokenStatus(repo, "my-bot", OWNER)).toEqual({ configured: false });

    const { token } = await generateApiToken(repo, "my-bot", OWNER);
    const status = await getApiTokenStatus(repo, "my-bot", OWNER);
    expect(status.configured).toBe(true);
    expect(status.createdAt).toBeTruthy();

    await revokeApiToken(repo, "my-bot", OWNER);
    expect(await getApiTokenStatus(repo, "my-bot", OWNER)).toEqual({ configured: false });
    expect(await verifyProjectApiToken(repo, "my-bot", token)).toBeNull();
  });

  it("rejects a non-owner status/revoke", async () => {
    const { repo } = makeRepo(project());
    await expect(getApiTokenStatus(repo, "my-bot", "x@example.com")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(revokeApiToken(repo, "my-bot", "x@example.com")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
