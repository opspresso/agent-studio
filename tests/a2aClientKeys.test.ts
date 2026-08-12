import { beforeEach, describe, expect, it } from "vitest";
import { createA2aClientKeyUseCases } from "@/application/a2a/clientKeyUseCases";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { setAuditSink } from "@/application/audit/recordAudit";
import type { A2aClientKey, A2aClientKeyRepository } from "@/domain/a2a/clientKey";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { hashSecret } from "@/shared/generatedSecret";

/** Identity cipher: these tests are about the lifecycle, not the encryption. */
const cipher = {
  encrypt: (v: string) => `enc:v1:${v}`,
  decrypt: (v: string) => v.replace(/^enc:v1:/, ""),
  mask: (v: string) => `${v.slice(0, 4)}••••`,
  isMasked: () => false,
} as unknown as SecretCipher;

function inMemoryRepo(): A2aClientKeyRepository & { rows: Map<string, A2aClientKey> } {
  const rows = new Map<string, A2aClientKey>();
  return {
    rows,
    async get(name) {
      return rows.get(name) ?? null;
    },
    async list() {
      return [...rows.values()];
    },
    async create(key) {
      if (rows.has(key.name)) {
        const error = new Error("conditional write lost");
        error.name = "TransactionCanceledException";
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

    expect(key).toMatch(/^adc_/);
    expect(view).toMatchObject({ name: "partner-batch", description: "nightly sync" });
    expect(view.masked).not.toContain(key.slice(8));
    await expect(useCases.verify(key)).resolves.toBe("partner-batch");
    await expect(useCases.verify("adc_wrong")).resolves.toBeNull();
  });

  it("stores the hash the verification row is keyed by", async () => {
    const repo = inMemoryRepo();
    const useCases = createA2aClientKeyUseCases(repo, cipher);

    const { key } = await useCases.create("partner", undefined, "admin@x.com");

    expect(repo.rows.get("partner")?.tokenHash).toBe(hashSecret(key));
  });

  it("refuses a duplicate name as a conflict", async () => {
    const useCases = createA2aClientKeyUseCases(inMemoryRepo(), cipher);
    await useCases.create("partner", undefined, "admin@x.com");

    await expect(useCases.create("partner", undefined, "admin@x.com")).rejects.toThrow(
      ConflictError,
    );
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
