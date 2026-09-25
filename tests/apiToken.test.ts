// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { describe, expect, it } from "vitest";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent, AgentApiToken } from "@/domain/agent/types";
import {
  generateApiToken as generateApiTokenImpl,
  getApiTokenStatus,
  revealApiToken as revealApiTokenImpl,
  revokeApiToken,
  verifyAgentApiToken as verifyAgentApiTokenImpl,
} from "@/application/agent/apiTokenUseCases";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { setAdminCheck } from "@/application/agent/agentUseCases";

// The cipher is injected now; every call below is unchanged.
type Gen = Parameters<typeof generateApiTokenImpl>;
type Rev = Parameters<typeof revealApiTokenImpl>;
type Ver = Parameters<typeof verifyAgentApiTokenImpl>;
const generateApiToken = (repo: Gen[0], name: Gen[1], email: Gen[2]) =>
  generateApiTokenImpl(repo, name, email, secretCipher);
const revealApiToken = (repo: Rev[0], name: Rev[1], email: Rev[2]) =>
  revealApiTokenImpl(repo, name, email, secretCipher);
const verifyAgentApiToken = (repo: Ver[0], name: Ver[1], token: Ver[2]) =>
  verifyAgentApiTokenImpl(repo, name, token, secretCipher);
import {
  generateSecretValue,
  hashSecret,
  secretHashEquals,
  secretPrefix,
} from "@/shared/generatedSecret";
import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
} from "@/infrastructure/crypto/secretEncryption";
import { agentApiTokenContext } from "@/domain/security/secretContext";

const OWNER = "owner@example.com";

function agent(): Agent {
  return {
    name: "my-bot",
    displayName: "My Bot",
    description: "",
    ownerEmail: OWNER,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeRepo(p: Agent | null): {
  repo: AgentRepository;
  stored: () => AgentApiToken | null;
} {
  let token: AgentApiToken | null = null;
  const repo: AgentRepository = {
    async get(name) {
      return p && p.name === name ? p : null;
    },
    async list() {
      return p ? [p] : [];
    },
    async create() {},
    async update() {},
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
    const a = generateSecretValue("agentApiToken");
    const b = generateSecretValue("agentApiToken");
    expect(a.startsWith(secretPrefix("agentApiToken"))).toBe(true);
    expect(a).not.toEqual(b);
  });

  it("gives each kind a two-char vendor prefix plus one kind character", () => {
    expect(secretPrefix("agentApiToken")).toBe("ast_");
    // The kinds must stay distinguishable from the string alone.
    expect(secretPrefix("triggerSecret")).not.toBe(secretPrefix("agentApiToken"));
  });

  it("keeps full entropy after the prefix", () => {
    const value = generateSecretValue("agentApiToken");
    // 32 random bytes as base64url = 43 chars, regardless of the prefix.
    expect(value.slice("ast_".length)).toHaveLength(43);
    expect(value).toMatch(/^ast_[A-Za-z0-9_-]{43}$/);
  });

  it("hashes deterministically and compares in constant time", () => {
    const token = "ast_abc";
    expect(hashSecret(token)).toEqual(hashSecret(token));
    expect(secretHashEquals(hashSecret(token), hashSecret(token))).toBe(true);
    expect(secretHashEquals(hashSecret("a"), hashSecret("b"))).toBe(false);
  });
});

describe("generateApiToken", () => {
  it("returns the raw token and stores it encrypted, never in plaintext", async () => {
    const { repo, stored } = makeRepo(agent());
    const { token, masked, createdAt } = await generateApiToken(repo, "my-bot", OWNER);

    expect(token.startsWith(secretPrefix("agentApiToken"))).toBe(true);
    expect(createdAt).toBeTruthy();
    // Stored encrypted so the owner can read it back — never as plaintext, and
    // with no hash left over from the form that could not be read back.
    expect(isEncrypted(stored()?.token ?? "")).toBe(true);
    expect(stored()?.token).not.toBe(token);
    expect(stored()?.token?.startsWith("enc:v2:")).toBe(true);
    expect(decryptSecret(stored()?.token ?? "", agentApiTokenContext("my-bot"))).toBe(token);
    expect(stored()?.tokenHash).toBeUndefined();

    // The stored mask is what lets the console show which token is set without
    // decrypting; it must never be enough to reconstruct one.
    expect(stored()?.masked).toBe(masked);
    expect(masked).toHaveLength(token.length);
    expect(masked).toContain("•");
    expect(masked).not.toContain(token.slice(8, -4));
  });

  it("leaves the prefix legible in the mask so the kind is still identifiable", async () => {
    // A 47-char token falls in the top reveal tier (first 4 + last 4), and the
    // prefix is exactly those first 4 — fixed and public, so showing it costs
    // nothing and keeps a masked value traceable to what it opens.
    const { repo } = makeRepo(agent());
    const { token, masked } = await generateApiToken(repo, "my-bot", OWNER);

    expect(masked.startsWith(secretPrefix("agentApiToken"))).toBe(true);
    expect(masked.endsWith(token.slice(-4))).toBe(true);
    // Everything between the edges is hidden.
    expect(masked.slice(4, -4)).toMatch(/^•+$/);
  });

  it("regeneration overwrites the previous token", async () => {
    const { repo } = makeRepo(agent());
    const first = await generateApiToken(repo, "my-bot", OWNER);
    const second = await generateApiToken(repo, "my-bot", OWNER);
    expect(first.token).not.toEqual(second.token);
    // The old token no longer verifies; the new one does.
    expect(await verifyAgentApiToken(repo, "my-bot", first.token)).toBeNull();
    expect(await verifyAgentApiToken(repo, "my-bot", second.token)).toBe(OWNER);
  });

  it("rejects a non-owner", async () => {
    const { repo, stored } = makeRepo(agent());
    await expect(generateApiToken(repo, "my-bot", "other@example.com")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(stored()).toBeNull();
  });

  describe("with a tier lookup injected", () => {
    it("refuses an owner whose tier may not use API tokens", async () => {
      const { repo, stored } = makeRepo(agent());
      await expect(
        generateApiTokenImpl(repo, "my-bot", OWNER, secretCipher, async () => "guest"),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(stored()).toBeNull();
    });

    it("gates on the owner's tier even when an admin asks", async () => {
      // The token would authenticate as the owner; a caller-scoped check
      // would let an admin mint a credential the execution gate refuses.
      const { repo, stored } = makeRepo(agent());
      const asked: string[] = [];
      const admin = "admin@example.com";
      setAdminCheck(async (email) => email === admin);
      try {
        await expect(
          generateApiTokenImpl(repo, "my-bot", admin, secretCipher, async (email) => {
            asked.push(email);
            return email === admin ? "admin" : "guest";
          }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      } finally {
        setAdminCheck(async () => false);
      }
      expect(asked).toEqual([OWNER]);
      expect(stored()).toBeNull();
    });

    it("allows a member owner and treats a missing row as the default guest tier", async () => {
      const { repo } = makeRepo(agent());
      await expect(
        generateApiTokenImpl(repo, "my-bot", OWNER, secretCipher, async () => "member"),
      ).resolves.toBeTruthy();
      await expect(
        generateApiTokenImpl(repo, "my-bot", OWNER, secretCipher, async () => null),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe("verifyAgentApiToken", () => {
  it("returns the owner email for a valid token", async () => {
    const { repo } = makeRepo(agent());
    const { token } = await generateApiToken(repo, "my-bot", OWNER);
    expect(await verifyAgentApiToken(repo, "my-bot", token)).toBe(OWNER);
  });

  it("returns null for a wrong token", async () => {
    const { repo } = makeRepo(agent());
    await generateApiToken(repo, "my-bot", OWNER);
    expect(await verifyAgentApiToken(repo, "my-bot", "ast_wrong")).toBeNull();
  });

  it("keeps a legacy v1 encrypted token usable during migration", async () => {
    const { repo } = makeRepo(agent());
    const token = "ast_legacy-encrypted-token";
    await repo.setApiToken("my-bot", {
      token: encryptSecret(token),
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(await verifyAgentApiToken(repo, "my-bot", token)).toBe(OWNER);
    expect(await revealApiToken(repo, "my-bot", OWNER)).toMatchObject({ token });
  });

  it("does not authenticate ciphertext moved from another agent row", async () => {
    const source = makeRepo(agent());
    const { token } = await generateApiToken(source.repo, "my-bot", OWNER);
    const target = makeRepo({ ...agent(), name: "other-bot" });
    await target.repo.setApiToken("other-bot", source.stored()!);

    expect(await verifyAgentApiToken(target.repo, "other-bot", token)).toBeNull();
    await expect(revealApiToken(target.repo, "other-bot", OWNER)).rejects.toThrow();
  });

  it("returns null when no token is configured", async () => {
    const { repo } = makeRepo(agent());
    expect(await verifyAgentApiToken(repo, "my-bot", "ast_anything")).toBeNull();
  });
});

describe("getApiTokenStatus / revokeApiToken", () => {
  it("reports configured state and revokes", async () => {
    const { repo } = makeRepo(agent());
    expect(await getApiTokenStatus(repo, "my-bot", OWNER)).toEqual({ configured: false });

    const { token, masked } = await generateApiToken(repo, "my-bot", OWNER);
    const status = await getApiTokenStatus(repo, "my-bot", OWNER);
    expect(status.configured).toBe(true);
    expect(status.createdAt).toBeTruthy();
    expect(status.masked).toBe(masked);
    expect(status.revealable).toBe(true);

    await revokeApiToken(repo, "my-bot", OWNER);
    expect(await getApiTokenStatus(repo, "my-bot", OWNER)).toEqual({ configured: false });
    expect(await verifyAgentApiToken(repo, "my-bot", token)).toBeNull();
  });

  it("rejects a non-owner status/revoke", async () => {
    const { repo } = makeRepo(agent());
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
    const { repo } = makeRepo(agent());
    // A row written by an older release: hash and timestamp only.
    await repo.setApiToken("my-bot", {
      tokenHash: hashSecret("sk_proj_legacy"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const status = await getApiTokenStatus(repo, "my-bot", OWNER);

    expect(status.configured).toBe(true);
    expect(status.masked).toBeUndefined();
    // The old token still verifies — the prefix was never part of verification.
    expect(await verifyAgentApiToken(repo, "my-bot", "sk_proj_legacy")).toBe(OWNER);
  });
});

describe("revealApiToken", () => {
  it("returns the token the owner generated", async () => {
    const { repo } = makeRepo(agent());
    const { token, createdAt } = await generateApiToken(repo, "my-bot", OWNER);

    expect(await revealApiToken(repo, "my-bot", OWNER)).toEqual({ token, createdAt });
  });

  it("refuses a token that predates encrypted storage instead of failing obscurely", async () => {
    // Hash-only rows have nothing to decrypt; the owner is told to regenerate.
    const { repo } = makeRepo(agent());
    await repo.setApiToken("my-bot", {
      tokenHash: hashSecret("ast_legacy"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(revealApiToken(repo, "my-bot", OWNER)).rejects.toBeInstanceOf(ValidationError);
    // Regenerating replaces it with a readable one.
    const { token } = await generateApiToken(repo, "my-bot", OWNER);
    expect((await revealApiToken(repo, "my-bot", OWNER)).token).toBe(token);
    // …and the legacy token stops working, because the hash is gone.
    expect(await verifyAgentApiToken(repo, "my-bot", "ast_legacy")).toBeNull();
  });

  it("rejects a non-owner and an agent with no token", async () => {
    const { repo } = makeRepo(agent());
    await generateApiToken(repo, "my-bot", OWNER);
    await expect(revealApiToken(repo, "my-bot", "other@example.com")).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    await revokeApiToken(repo, "my-bot", OWNER);
    await expect(revealApiToken(repo, "my-bot", OWNER)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("authenticates nobody when the stored token cannot be decrypted", async () => {
    // A rotated or wrong AES key must fail closed, not fall through to a match.
    const { repo } = makeRepo(agent());
    await repo.setApiToken("my-bot", {
      token: "enc:v1:not-real-ciphertext",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(await verifyAgentApiToken(repo, "my-bot", "ast_anything")).toBeNull();
  });
});
