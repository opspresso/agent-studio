import { describe, expect, it, vi } from "vitest";
import { createTriggerUseCases } from "@/application/trigger/triggerUseCases";
import { createTriggerSchema } from "@/app/api/projects/_lib/schemas";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { toSlug } from "@/shared/slug";
import { ForbiddenError, NotFoundError } from "@/application/errors";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project } from "@/domain/project/types";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { WebhookTrigger } from "@/domain/trigger/types";

process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");

const project: Project = {
  name: "p",
  displayName: "P",
  description: "",
  projectType: "agent",
  ownerEmail: "owner@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function fixture() {
  const stored = new Map<string, WebhookTrigger>();
  const triggers: TriggerRepository = {
    get: async (_p, id) => stored.get(id) ?? null,
    listByProject: async () => [...stored.values()],
    create: async (t) => void stored.set(t.triggerId, t),
    put: async (t) => void stored.set(t.triggerId, t),
    delete: async (_p, id) => void stored.delete(id),
    claimIdempotencyKey: async () => true,
    appendRun: async () => {},
    finishRun: async () => {},
    listRuns: async () => [],
  };
  const projects = { get: async () => project } as unknown as ProjectRepository;
  return { stored, useCases: createTriggerUseCases({ triggers, projects, cipher: secretCipher }) };
}

describe("trigger ids follow the project-name rule", () => {
  it("normalises the same way a project name does", () => {
    // The console slugifies on blur; these are the inputs it has to survive.
    expect(toSlug("Nightly Report")).toBe("nightly-report");
    expect(toSlug("  My_Trigger!! ")).toBe("my-trigger");
    expect(toSlug("--a--b--")).toBe("a-b");
  });

  it("is rejected by the API when it is not already a slug", () => {
    // The client normalises; the schema is what makes it true regardless of client.
    expect(createTriggerSchema.safeParse({ triggerId: "Nightly Report" }).success).toBe(false);
    expect(createTriggerSchema.safeParse({ triggerId: "nightly-report" }).success).toBe(true);
  });
});

describe("trigger secret", () => {
  it("comes back in the clear once on create, and masked afterwards", async () => {
    const { useCases } = fixture();
    const created = await useCases.create("p", { triggerId: "t1" }, "owner@example.com");
    expect(created.secret).toMatch(/^asw_/);
    const [listed] = await useCases.list("p", "owner@example.com");
    expect(listed?.secret).toBeUndefined();
    expect(listed?.secretMasked).toMatch(/^asw_•+/);
  });

  it("is stored encrypted, never in plaintext", async () => {
    const { stored, useCases } = fixture();
    const created = await useCases.create("p", { triggerId: "t1" }, "owner@example.com");
    expect(stored.get("t1")!.secret).not.toBe(created.secret);
    expect(stored.get("t1")!.secret.startsWith("enc:")).toBe(true);
  });

  it("can be read back, like a project API token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { useCases } = fixture();
    const created = await useCases.create("p", { triggerId: "t1" }, "owner@example.com");
    const revealed = await useCases.reveal("p", "t1", "owner@example.com");
    expect(revealed.secret).toBe(created.secret);
    // Secret access leaves a trail even when it is authorized.
    expect(warn.mock.calls.some(([line]) => String(line).includes("revealed by"))).toBe(true);
    warn.mockRestore();
  });

  it("refuses a reveal to anyone but the owner or an admin", async () => {
    const { useCases } = fixture();
    await useCases.create("p", { triggerId: "t1" }, "owner@example.com");
    await expect(useCases.reveal("p", "t1", "someone@example.com")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("404s a reveal for a trigger that does not exist", async () => {
    const { useCases } = fixture();
    await expect(useCases.reveal("p", "nope", "owner@example.com")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("regenerating returns the new secret once and invalidates the old", async () => {
    const { useCases } = fixture();
    const created = await useCases.create("p", { triggerId: "t1" }, "owner@example.com");
    const rotated = await useCases.update(
      "p",
      "t1",
      { rotateSecret: true },
      "owner@example.com",
    );
    expect(rotated.secret).toMatch(/^asw_/);
    expect(rotated.secret).not.toBe(created.secret);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await useCases.reveal("p", "t1", "owner@example.com")).secret).toBe(rotated.secret);
    warn.mockRestore();
  });

  it("an ordinary update leaves the secret alone", async () => {
    const { useCases } = fixture();
    const created = await useCases.create("p", { triggerId: "t1" }, "owner@example.com");
    const updated = await useCases.update("p", "t1", { enabled: false }, "owner@example.com");
    expect(updated.secret).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await useCases.reveal("p", "t1", "owner@example.com")).secret).toBe(created.secret);
    warn.mockRestore();
  });
});
