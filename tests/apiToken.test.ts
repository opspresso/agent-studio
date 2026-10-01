import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCredentialUseCases } from "@/application/agent/agentCredentialUseCases";
import { setAdminCheck } from "@/application/agent/agentUseCases";
import { agentCredentialRepository } from "@/infrastructure/db/repositories/agentCredentialRepository";
import { agentRepository } from "@/infrastructure/db/repositories/agentRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { agentCredentialContext } from "@/domain/security/secretContext";
import { keys } from "@/infrastructure/db/keys";
import { generateSecretValue, secretPrefix } from "@/shared/generatedSecret";
import type { Member } from "@/domain/member/types";
import type { FakeStore } from "./fakeStore";

const entropy = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomBytes: (size: number) => {
  const bytes = Buffer.alloc(size); bytes.writeUInt32BE(++entropy.sequence); return bytes;
} }));
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const now = new Date("2026-10-01T08:00:00Z");
let sequence: number;
const members = new Map<string, Member>();
const api = createAgentCredentialUseCases({ purpose: "api", agents: agentRepository, tokens: agentCredentialRepository, members: { getById: async id => members.get(id) ?? null },
  cipher: secretCipher, now: () => now, newId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` });
const member = (id: string, email: string): Member => ({ id, email, name: id, image: null, tier: "member", joinedAt: now.toISOString(), lastLoginAt: now.toISOString() });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); sequence = 0; entropy.sequence = 0; store.rows.clear(); members.clear();
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
  setAdminCheck(async email => email === "admin@example.test");
  members.set("first", member("first", "first@example.test")); members.set("second", member("second", "second@example.test"));
  members.set("admin", { ...member("admin", "admin@example.test"), tier: "admin" });
  for (const name of ["bot", "other"]) await agentRepository.create({ name, displayName: name, description: "", ownerEmail: "first@example.test", createdAt: now.toISOString(), updatedAt: now.toISOString() });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); setAdminCheck(async () => false); });

async function privateAgent() {
  const agent = (await agentRepository.get("bot"))!;
  await agentRepository.update({ ...agent, visibility: "private", memberEmails: [] }, agent.updatedAt);
}

describe("generated secret values", () => {
  it("keeps purpose prefixes distinct without reducing the 32-byte random secret", () => {
    const first = generateSecretValue("agentApiToken"); const second = generateSecretValue("agentApiToken");
    expect(first.startsWith(secretPrefix("agentApiToken"))).toBe(true);
    expect(first).not.toBe(second);
    expect(secretPrefix("triggerSecret")).not.toBe(secretPrefix("agentApiToken"));
    expect(Buffer.from(first.slice(4), "base64url")).toHaveLength(32);
  });
});

describe("personal API tokens", () => {
  it("stores a context-bound encrypted token for its issuing user, without an Agent-owner credential", async () => {
    const issued = await api.generate("bot", "second");
    expect(issued.token).toMatch(/^ast_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    const record = (await agentCredentialRepository.forUser("bot", "api", "second"))!;
    const stored = (await agentCredentialRepository.get("bot", "api", record.id))!;
    expect(stored.userId).toBe("second"); expect(stored.token).not.toBe(issued.token);
    expect(secretCipher.decrypt(stored.token, agentCredentialContext("bot", "api", "second", stored.id))).toBe(issued.token);
    expect(await api.verify("bot", issued.token)).toEqual({ userId: "second", email: "second@example.test", credentialId: issued.credentialId });
    expect(await api.status("bot", "first")).toEqual({ configured: false, canIssue: true });
  });

  it("rotates and revokes one user's token without changing another user's credential", async () => {
    const first = await api.generate("bot", "first"); const second = await api.generate("bot", "second");
    const rotated = await api.generate("bot", "first");
    expect(await api.verify("bot", first.token)).toBeNull();
    expect(await api.verify("bot", rotated.token)).toMatchObject({ userId: "first" });
    expect(await api.verify("bot", second.token)).toMatchObject({ userId: "second" });
    await api.revoke("bot", "first");
    expect(await api.verify("bot", rotated.token)).toBeNull();
    expect(await api.verify("bot", second.token)).toMatchObject({ userId: "second" });
  });

  it("does not let an administrator reveal or revoke another user's token", async () => {
    const issued = await api.generate("bot", "first");
    expect(await api.status("bot", "admin")).toEqual({ configured: false, canIssue: true });
    await expect(api.reveal("bot", "admin")).rejects.toMatchObject({ status: 404 });
    await api.revoke("bot", "admin");
    expect((await api.reveal("bot", "first")).token).toBe(issued.token);
  });

  it("keeps the issuer unchanged after Agent ownership changes", async () => {
    const issued = await api.generate("bot", "first"); const agent = (await agentRepository.get("bot"))!;
    await agentRepository.update({ ...agent, ownerEmail: "second@example.test" }, agent.updatedAt);
    expect(await api.verify("bot", issued.token)).toEqual({ userId: "first", email: "first@example.test", credentialId: issued.credentialId });
  });

  it("checks current private Agent access for issuance and every token invocation", async () => {
    const issued = await api.generate("bot", "second"); await privateAgent();
    await expect(api.verify("bot", issued.token)).rejects.toMatchObject({ status: 403 });
    await expect(api.generate("bot", "second")).rejects.toMatchObject({ status: 403 });
    expect(await api.verify("bot", (await api.generate("bot", "first")).token)).toMatchObject({ userId: "first" });
  });

  it("checks current account tier, and still lets a downgraded user revoke their own token", async () => {
    const issued = await api.generate("bot", "second"); members.get("second")!.tier = "guest";
    await expect(api.verify("bot", issued.token)).rejects.toMatchObject({ status: 403 });
    await expect(api.generate("bot", "second")).rejects.toMatchObject({ status: 403 });
    expect(await api.status("bot", "second")).toMatchObject({ configured: true, canIssue: false });
    await api.revoke("bot", "second");
    expect(await api.status("bot", "second")).toEqual({ configured: false, canIssue: false });
  });

  it("does not transfer a deleted user's credential to a new account with the same email", async () => {
    const issued = await api.generate("bot", "second"); members.delete("second");
    members.set("replacement", member("replacement", "second@example.test"));
    expect(await api.verify("bot", issued.token)).toBeNull();
    expect(await api.status("bot", "replacement")).toEqual({ configured: false, canIssue: true });
  });

  it("uses the current email of the same stable user ID", async () => {
    const issued = await api.generate("bot", "second"); members.get("second")!.email = "renamed@example.test";
    expect(await api.verify("bot", issued.token)).toEqual({ userId: "second", email: "renamed@example.test", credentialId: issued.credentialId });
  });

  it("rejects legacy shared tokens, wrong secrets and another Agent's token without identity fallback", async () => {
    const issued = await api.generate("bot", "first");
    expect(await api.verify("bot", "ast_legacy-owner-token")).toBeNull();
    expect(await api.verify("bot", issued.token.slice(0, -1) + "Z")).toBeNull();
    expect(await api.verify("other", issued.token)).toBeNull();
  });

  it("does not authenticate a ciphertext moved to another user or Agent record", async () => {
    const first = await api.generate("bot", "first"); const second = await api.generate("bot", "second");
    const firstMeta = (await agentCredentialRepository.forUser("bot", "api", "first"))!;
    const secondMeta = (await agentCredentialRepository.forUser("bot", "api", "second"))!;
    const firstRow = store.rows.get(`${keys.agentCredential("bot", "api", firstMeta.id).PK}\0${keys.agentCredential("bot", "api", firstMeta.id).SK}`)!;
    const secondKey = keys.agentCredential("bot", "api", secondMeta.id);
    const secondRow = store.rows.get(`${secondKey.PK}\0${secondKey.SK}`)!;
    secondRow.token = firstRow.token;
    await expect(api.verify("bot", second.token)).rejects.toThrow();
    expect(await api.verify("bot", first.token)).toMatchObject({ userId: "first" });
  });

  it("rejects a concurrent rotation instead of publishing two live credentials for one user", async () => {
    const results = await Promise.allSettled([api.generate("bot", "first"), api.generate("bot", "first")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const fulfilled = results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof api.generate>>>;
    expect(await api.verify("bot", fulfilled.value.token)).toMatchObject({ userId: "first" });
  });

  it("fences creation against Agent retirement and deletes personal tokens with their Agent", async () => {
    const issued = await api.generate("bot", "first"); await agentRepository.delete("bot");
    expect(await api.verify("bot", issued.token)).toBeNull();
    await expect(api.generate("bot", "first")).rejects.toMatchObject({ status: 404 });
  });
});


describe("purpose-scoped personal credentials", () => {
  const webhooks = createAgentCredentialUseCases({ purpose: "webhook", agents: agentRepository, tokens: agentCredentialRepository,
    members: { getById: async id => members.get(id) ?? null }, cipher: secretCipher, now: () => now,
    newId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` });

  it("isolates one user's API and Webhook credentials, including rotation and revocation", async () => {
    const apiToken = await api.generate("bot", "first");
    const webhookToken = await webhooks.generate("bot", "first");
    expect(webhookToken.token).toMatch(/^asw_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(await api.verify("bot", webhookToken.token)).toBeNull();
    expect(await webhooks.verify("bot", apiToken.token)).toBeNull();
    expect(await api.verify("bot", webhookToken.token.replace(/^asw_/, "ast_"))).toBeNull();
    const rotated = await webhooks.generate("bot", "first");
    expect(await webhooks.authorize("bot", webhookToken.credentialId, "first")).toBeNull();
    expect(await api.verify("bot", apiToken.token)).toMatchObject({ userId: "first", credentialId: apiToken.credentialId });
    await webhooks.revoke("bot", "first");
    expect(await webhooks.verify("bot", rotated.token)).toBeNull();
    expect(await api.verify("bot", apiToken.token)).toMatchObject({ userId: "first" });
  });

  it("authenticates a signed body with the selected user's Webhook secret", async () => {
    const issued = await webhooks.generate("bot", "second");
    const body = '{"action":"opened"}';
    const signature = "sha256=" + createHmac("sha256", issued.token).update(body).digest("hex");
    expect(await webhooks.verifySignature("bot", issued.credentialId, body, signature)).toEqual({ userId: "second", email: "second@example.test", credentialId: issued.credentialId });
    expect(await webhooks.verifySignature("bot", issued.credentialId, body + " ", signature)).toBeNull();
    expect(await webhooks.verifySignature("other", issued.credentialId, body, signature)).toBeNull();
    expect(await webhooks.verifySignature("bot", "invalid", body, signature)).toBeNull();
    expect(await api.verifySignature("bot", issued.credentialId, body, signature)).toBeNull();
    expect(await webhooks.authorize("bot", issued.credentialId, "first")).toBeNull();
    members.get("second")!.tier = "guest";
    await expect(webhooks.verifySignature("bot", issued.credentialId, body, signature)).rejects.toMatchObject({ status: 403 });
  });

  it("requires a current credential and the same issuing user before later effects", async () => {
    const issued = await webhooks.generate("bot", "second");
    expect(await webhooks.authorize("bot", issued.credentialId, "second")).toMatchObject({ userId: "second" });
    await privateAgent();
    await expect(webhooks.authorize("bot", issued.credentialId, "second")).rejects.toMatchObject({ status: 403 });
    await webhooks.revoke("bot", "second");
    expect(await webhooks.authorize("bot", issued.credentialId, "second")).toBeNull();
  });

  it("rejects ciphertext copied between purposes even when both records belong to the same user", async () => {
    const issued = await api.generate("bot", "first");
    const webhook = await webhooks.generate("bot", "first");
    const storedApi = (await agentCredentialRepository.get("bot", "api", issued.credentialId))!;
    const key = keys.agentCredential("bot", "webhook", webhook.credentialId);
    const row = store.rows.get(`${key.PK}\0${key.SK}`)!;
    row.token = storedApi.token;
    await expect(webhooks.reveal("bot", "first")).rejects.toThrow();
    await expect(webhooks.verify("bot", webhook.token)).rejects.toThrow();
  });
});
