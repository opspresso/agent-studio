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
  generateSecretValue,
  hashSecret,
  secretHashEquals,
  secretPrefix,
} from "@/lib/generatedSecret";
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

describe("generated secret helpers", () => {
  it("generates prefixed, unique token values", () => {
    const a = generateSecretValue("projectApiToken");
    const b = generateSecretValue("projectApiToken");
    expect(a.startsWith(secretPrefix("projectApiToken"))).toBe(true);
    expect(a).not.toEqual(b);
  });

  it("gives each kind a two-char vendor prefix plus one kind character", () => {
    expect(secretPrefix("a2aApiKey")).toBe("asa_");
    expect(secretPrefix("projectApiToken")).toBe("ast_");
    // The kinds must stay distinguishable from the string alone.
    expect(secretPrefix("a2aApiKey")).not.toBe(secretPrefix("projectApiToken"));
  });

  it("keeps full entropy after the prefix", () => {
    const value = generateSecretValue("a2aApiKey");
    // 32 random bytes as base64url = 43 chars, regardless of the prefix.
    expect(value.slice("asa_".length)).toHaveLength(43);
    expect(value).toMatch(/^asa_[A-Za-z0-9_-]{43}$/);
  });

  it("hashes deterministically and compares in constant time", () => {
    const token = "ast_abc";
    expect(hashSecret(token)).toEqual(hashSecret(token));
    expect(secretHashEquals(hashSecret(token), hashSecret(token))).toBe(true);
    expect(secretHashEquals(hashSecret("a"), hashSecret("b"))).toBe(false);
  });
});

describe("generateApiToken", () => {
  it("returns the raw token and stores only its hash", async () => {
    const { repo, stored } = makeRepo(project());
    const { token, masked, createdAt } = await generateApiToken(repo, "my-bot", OWNER);

    expect(token.startsWith(secretPrefix("projectApiToken"))).toBe(true);
    expect(createdAt).toBeTruthy();
    // Only the hash is persisted — never the raw value.
    expect(stored()?.tokenHash).toBe(hashSecret(token));
    expect(stored()?.tokenHash).not.toBe(token);

    // The stored mask is what lets the console show which token is set; it must
    // never be enough to reconstruct one.
    expect(stored()?.masked).toBe(masked);
    expect(masked).toHaveLength(token.length);
    expect(masked).toContain("•");
    expect(masked).not.toContain(token.slice(8, -4));
    expect(hashSecret(masked)).not.toBe(stored()?.tokenHash);
  });

  it("leaves the prefix legible in the mask so the kind is still identifiable", async () => {
    // A 47-char token falls in the top reveal tier (first 4 + last 4), and the
    // prefix is exactly those first 4 — fixed and public, so showing it costs
    // nothing and keeps a masked value traceable to what it opens.
    const { repo } = makeRepo(project());
    const { token, masked } = await generateApiToken(repo, "my-bot", OWNER);

    expect(masked.startsWith(secretPrefix("projectApiToken"))).toBe(true);
    expect(masked.endsWith(token.slice(-4))).toBe(true);
    // Everything between the edges is hidden.
    expect(masked.slice(4, -4)).toMatch(/^•+$/);
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
    expect(await verifyProjectApiToken(repo, "my-bot", "ast_wrong")).toBeNull();
  });

  it("returns null when no token is configured", async () => {
    const { repo } = makeRepo(project());
    expect(await verifyProjectApiToken(repo, "my-bot", "ast_anything")).toBeNull();
  });
});

describe("getApiTokenStatus / revokeApiToken", () => {
  it("reports configured state and revokes", async () => {
    const { repo } = makeRepo(project());
    expect(await getApiTokenStatus(repo, "my-bot", OWNER)).toEqual({ configured: false });

    const { token, masked } = await generateApiToken(repo, "my-bot", OWNER);
    const status = await getApiTokenStatus(repo, "my-bot", OWNER);
    expect(status.configured).toBe(true);
    expect(status.createdAt).toBeTruthy();
    expect(status.masked).toBe(masked);

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

describe("getApiTokenStatus for tokens issued before masks existed", () => {
  it("reports configured without a mask instead of inventing one", async () => {
    const { repo } = makeRepo(project());
    // A row written by an older release: hash and timestamp only.
    await repo.setApiToken("my-bot", {
      tokenHash: hashSecret("sk_proj_legacy"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const status = await getApiTokenStatus(repo, "my-bot", OWNER);

    expect(status.configured).toBe(true);
    expect(status.masked).toBeUndefined();
    // The old token still verifies — the prefix was never part of verification.
    expect(await verifyProjectApiToken(repo, "my-bot", "sk_proj_legacy")).toBe(OWNER);
  });
});
