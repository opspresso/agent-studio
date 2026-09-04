import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  A2A_CLIENT_KEY_LIST_PAGE_SIZE,
  createA2aClientKeyUseCases,
} from "@/application/a2a/clientKeyUseCases";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { setAuditSink } from "@/application/audit/recordAudit";
import type { A2aClientKey, A2aClientKeyRepository } from "@/domain/a2a/clientKey";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { hashSecret } from "@/shared/generatedSecret";

/** Identity cipher: these tests are about the lifecycle, not the encryption. */
function decrypt(value: string, context?: string): string {
  if (value.startsWith("enc:v1:")) return value.slice("enc:v1:".length);
  const prefix = `enc:v2:${encodeURIComponent(context ?? "")}:`;
  if (!value.startsWith(prefix)) throw new Error("wrong encryption context");
  return value.slice(prefix.length);
}

const cipher = {
  encrypt: (v: string, context?: string) =>
    context ? `enc:v2:${encodeURIComponent(context)}:${v}` : `enc:v1:${v}`,
  decrypt,
  mask: (v: string) => `${v.slice(0, 4)}••••`,
  isMasked: () => false,
  decryptEquals(stored: string, candidate: string, context?: string) {
    return decrypt(stored, context) === candidate;
  },
} as unknown as SecretCipher;

function inMemoryRepo(): A2aClientKeyRepository & { rows: Map<string, A2aClientKey> } {
  const rows = new Map<string, A2aClientKey>();
  return {
    rows,
    async get(name) {
      return rows.get(name) ?? null;
    },
    async list(limit, after) {
      return [...rows.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter((key) => !after || key.name > after)
        .slice(0, limit);
    },
    async create(key) {
      if (rows.has(key.name)) {
        // The name the store gives a transaction one of whose conditions
        // failed — the real repository writes the pair transactionally, and
        // `isConditionalWriteFailure` reads it with `includeTransaction`.
        const error = new Error("conditional write lost");
        error.name = "TransactionCancelled";
        throw error;
      }
      rows.set(key.name, key);
    },
    async delete(name) {
      return rows.delete(name);
    },
    async findNameByHash(tokenHash) {
      for (const key of rows.values()) {
        if (key.tokenHash === tokenHash) {
          return key.name;
        }
      }
      return null;
    },
  };
}

describe("a2aClientKeyUseCases", () => {
  beforeEach(() => {
    setAuditSink({ append: async () => {}, listByDay: async () => [] });
  });

  it("issues a prefixed key once and verifies it back to the client name", async () => {
    const useCases = createA2aClientKeyUseCases(inMemoryRepo(), cipher);

    const { key, view } = await useCases.create("partner-batch", "nightly sync", "admin@x.com");

    expect(key).toMatch(/^asc_/);
    expect(view).toMatchObject({ name: "partner-batch", description: "nightly sync" });
    expect(view.masked).not.toContain(key.slice(8));
    await expect(useCases.verify(key)).resolves.toBe("partner-batch");
    await expect(useCases.verify("asc_wrong")).resolves.toBeNull();
  });

  it("stores the hash the verification row is keyed by", async () => {
    const repo = inMemoryRepo();
    const useCases = createA2aClientKeyUseCases(repo, cipher);

    const { key } = await useCases.create("partner", undefined, "admin@x.com");

    expect(repo.rows.get("partner")?.tokenHash).toBe(hashSecret(key));
  });

  it("does not authenticate a key row moved under another client name", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const repo = inMemoryRepo();
    const useCases = createA2aClientKeyUseCases(repo, cipher);
    const { key } = await useCases.create("partner", undefined, "admin@x.com");
    const stored = repo.rows.get("partner")!;
    repo.rows.delete("partner");
    repo.rows.set("other-client", { ...stored, name: "other-client" });

    await expect(useCases.verify(key)).resolves.toBeNull();
    await expect(useCases.reveal("other-client", "admin@x.com")).rejects.toThrow(
      "wrong encryption context",
    );
    expect(error).toHaveBeenCalled();
  });

  it("keeps a legacy v1 encrypted client key usable during migration", async () => {
    const repo = inMemoryRepo();
    const value = "asc_legacy-client-key";
    repo.rows.set("legacy", {
      name: "legacy",
      token: `enc:v1:${value}`,
      tokenHash: hashSecret(value),
      masked: "asc_••••",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(createA2aClientKeyUseCases(repo, cipher).verify(value)).resolves.toBe("legacy");
  });

  it("refuses a duplicate name as a conflict", async () => {
    const useCases = createA2aClientKeyUseCases(inMemoryRepo(), cipher);
    await useCases.create("partner", undefined, "admin@x.com");

    await expect(useCases.create("partner", undefined, "admin@x.com")).rejects.toThrow(
      ConflictError,
    );
  });

  it("lists every key through bounded repository pages", async () => {
    const repo = inMemoryRepo();
    for (let index = 0; index < A2A_CLIENT_KEY_LIST_PAGE_SIZE + 2; index += 1) {
      const name = `client-${String(index).padStart(3, "0")}`;
      repo.rows.set(name, {
        name,
        token: `enc:v1:${name}`,
        tokenHash: hashSecret(name),
        masked: `${name.slice(0, 4)}••••`,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    }
    const list = repo.list.bind(repo);
    const pageSizes: number[] = [];
    repo.list = async (limit, after) => {
      const page = await list(limit, after);
      pageSizes.push(page.length);
      return page;
    };
    const useCases = createA2aClientKeyUseCases(repo, cipher);

    await expect(useCases.list()).resolves.toHaveLength(repo.rows.size);
    expect(pageSizes).toEqual([A2A_CLIENT_KEY_LIST_PAGE_SIZE, 2]);
    await expect(useCases.hasAny()).resolves.toBe(true);
    expect(pageSizes.at(-1)).toBe(1);
  });

  it("refuses a name that is not a slug", async () => {
    const useCases = createA2aClientKeyUseCases(inMemoryRepo(), cipher);

    await expect(useCases.create("Not A Slug", undefined, "admin@x.com")).rejects.toThrow(
      ValidationError,
    );
  });

  it("refuses the shared key's own actor id as a name", async () => {
    const useCases = createA2aClientKeyUseCases(inMemoryRepo(), cipher);

    // A client named `shared-key` would merge with the anonymous shared-key
    // actor — same usage rows, same concurrency ceiling — defeating the point.
    await expect(useCases.create("shared-key", undefined, "admin@x.com")).rejects.toThrow(
      ValidationError,
    );
  });

  it("revoking a key that does not exist is a not-found, not a silent success", async () => {
    const useCases = createA2aClientKeyUseCases(inMemoryRepo(), cipher);

    await expect(useCases.revoke("ghost", "admin@x.com")).rejects.toThrow(NotFoundError);
  });

  it("reveals the stored key and revokes it for good", async () => {
    const useCases = createA2aClientKeyUseCases(inMemoryRepo(), cipher);
    const { key } = await useCases.create("partner", undefined, "admin@x.com");

    await expect(useCases.reveal("partner", "admin@x.com")).resolves.toMatchObject({ key });

    await useCases.revoke("partner", "admin@x.com");
    await expect(useCases.verify(key)).resolves.toBeNull();
    await expect(useCases.reveal("partner", "admin@x.com")).rejects.toThrow(NotFoundError);
  });
});
