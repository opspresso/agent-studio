import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createMessagingIdentityUseCases } from "@/application/auth/messagingIdentityUseCases";
import { messagingIdentityRepository } from "@/infrastructure/db/repositories/messagingIdentityRepository";
import { agentRepository } from "@/infrastructure/db/repositories/agentRepository";
import { authenticateMessagingSubject } from "@/application/messaging/authenticateSubject";
import type { Member } from "@/domain/member/types";
import type { MessagingSubject } from "@/domain/messaging/identity";
import type { FakeStore } from "./fakeStore";
const entropy = vi.hoisted(() => ({ value: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomBytes: (size: number) => Buffer.alloc(size, ++entropy.value) }));
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
let now: Date;
const members = new Map<string, Member>();
const api = createMessagingIdentityUseCases({ identities: messagingIdentityRepository, agents: agentRepository, members: { getById: async id => members.get(id) ?? null }, now: () => now });
const subject: MessagingSubject = { agentName: "agent", platform: "slack", realm: "workspace", externalId: "user" };
beforeEach(async () => {
  now = new Date("2026-10-01T08:00:00Z"); vi.useFakeTimers(); vi.setSystemTime(now); store.rows.clear(); members.clear(); entropy.value = 0;
  for (const id of ["first", "second"]) members.set(id, { id, email: `${id}@example.test`, name: id, tier: "member", image: null, joinedAt: now.toISOString(), lastLoginAt: now.toISOString() });
  for (const name of ["agent", "other"]) await agentRepository.create({ name, displayName: name, description: "", ownerEmail: "first@example.test", createdAt: now.toISOString(), updatedAt: now.toISOString() });
});
afterEach(() => { vi.useRealTimers(); });

describe("verified Studio-to-messaging identity", () => {
  it("uses a one-time hashed code and resolves the issuing user rather than the Agent owner", async () => {
    const issued = await api.issue("agent", "slack", "second");
    expect(JSON.stringify([...store.rows.values()])).not.toContain(issued.code);
    expect(await api.connect(subject, issued.code)).toEqual({ userId: "second", email: "second@example.test" });
    expect(await api.resolve(subject)).toEqual({ userId: "second", email: "second@example.test" });
    await expect(api.connect({ ...subject, externalId: "another" }, issued.code)).rejects.toMatchObject({ status: 400 });
  });
  it("does not authenticate an unlinked sender or another workspace with the same sender ID", async () => {
    expect(await api.resolve(subject)).toBeNull();
    await api.connect(subject, (await api.issue("agent", "slack", "first")).code);
    expect(await api.resolve({ ...subject, realm: "other-workspace" })).toBeNull();
  });
  it("does not consume a code for a different Agent or platform", async () => {
    const issued = await api.issue("agent", "slack", "first");
    await expect(api.connect({ ...subject, agentName: "other" }, issued.code)).rejects.toMatchObject({ status: 400 });
    await expect(api.connect({ ...subject, platform: "teams" }, issued.code)).rejects.toMatchObject({ status: 400 });
    expect(await api.connect(subject, issued.code)).toMatchObject({ userId: "first" });
  });
  it("expires unused codes and rejects read-only account issuance", async () => {
    const issued = await api.issue("agent", "slack", "first"); now = new Date(now.getTime() + 601000);
    await expect(api.connect(subject, issued.code)).rejects.toMatchObject({ status: 400 });
    members.get("first")!.tier = "guest";
    await expect(api.issue("agent", "slack", "first")).rejects.toMatchObject({ status: 403 });
  });
  it("does not replace another user's binding or let them unlink it", async () => {
    await api.connect(subject, (await api.issue("agent", "slack", "first")).code);
    await expect(api.connect(subject, (await api.issue("agent", "slack", "second")).code)).rejects.toMatchObject({ status: 409 });
    await expect(api.unlink(subject, "second")).rejects.toMatchObject({ status: 403 });
    await api.unlink(subject, "first"); expect(await api.resolve(subject)).toBeNull();
  });
  it("uses current user identity and permissions and never adopts a re-created account's email", async () => {
    await api.connect(subject, (await api.issue("agent", "slack", "first")).code);
    members.get("first")!.email = "renamed@example.test";
    expect(await api.resolve(subject)).toEqual({ userId: "first", email: "renamed@example.test" });
    members.delete("first"); members.set("replacement", { ...members.get("second")!, id: "replacement", email: "renamed@example.test" });
    await expect(api.resolve(subject)).rejects.toMatchObject({ status: 403 });
  });
  it("rechecks private Agent access and does not burn a code on denial", async () => {
    const issued = await api.issue("agent", "slack", "second"); const agent = (await agentRepository.get("agent"))!;
    await agentRepository.update({ ...agent, visibility: "private" }, agent.updatedAt);
    await expect(api.connect(subject, issued.code)).rejects.toMatchObject({ status: 403 });
  });
  it("lets only one sender consume a concurrently submitted code", async () => {
    const issued = await api.issue("agent", "slack", "first");
    const results = await Promise.allSettled([api.connect(subject, issued.code), api.connect({ ...subject, externalId: "other" }, issued.code)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it("checks current membership on every request and allows a downgraded user to unlink", async () => {
    await api.connect(subject, (await api.issue("agent", "slack", "first")).code);
    members.get("first")!.tier = "guest";
    await expect(api.resolve(subject)).rejects.toMatchObject({ status: 403 });
    await api.unlink(subject, "first");
    expect(await api.resolve(subject)).toBeNull();
  });
  it("removes unused codes and linked identities with the deleted Agent", async () => {
    const issued = await api.issue("agent", "slack", "first");
    await api.connect(subject, (await api.issue("agent", "slack", "first")).code);
    await agentRepository.delete("agent");
    await expect(api.connect(subject, issued.code)).rejects.toMatchObject({ status: 400 });
    expect(await api.resolve(subject)).toBeNull();
    expect(await api.list("first")).toEqual([]);
  });
  it.each(["auth", "/auth", "auth invalid extra text", " /auth@bot invalid"])("never treats an invalid authentication command as a model request: %s", async text => {
    await api.connect(subject, (await api.issue("agent", "slack", "first")).code);
    const reply = { say: vi.fn(async () => {}) };
    expect(await authenticateMessagingSubject(api, subject, text, true, reply)).toBeNull();
    expect(reply.say).toHaveBeenCalledWith("Invalid messaging authentication code");
  });
  it("handles authentication before Agent history and does not accept a command in a public channel", async () => {
    const issued = await api.issue("agent", "slack", "first"); const reply = { say: vi.fn(async () => {}) };
    expect(await authenticateMessagingSubject(api, subject, `/auth ${issued.code}`, false, reply)).toBeNull();
    expect(await api.resolve(subject)).toBeNull();
    expect(await authenticateMessagingSubject(api, subject, `/auth ${issued.code}`, true, reply)).toBeNull();
    expect(await api.resolve(subject)).toMatchObject({ userId: "first" });
  });
});
