import { describe, expect, it, vi } from "vitest";
import { createTriggerUseCases } from "@/application/trigger/triggerUseCases";
import { createTriggerSchema } from "@/app/api/projects/_lib/schemas";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { toSlug } from "@/shared/slug";
import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project } from "@/domain/project/types";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { Trigger, WebhookTrigger } from "@/domain/trigger/types";

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
  const stored = new Map<string, Trigger>();
  const triggers: TriggerRepository = {
    get: async (_p, id) => stored.get(id) ?? null,
    listByProject: async () => [...stored.values()],
    listSchedules: async () =>
      [...stored.values()].filter((t) => t.kind === "schedule"),
    create: async (t) => void stored.set(t.triggerId, t),
    put: async (t) => void stored.set(t.triggerId, t),
    delete: async (_p, id) => void stored.delete(id),
    claimIdempotencyKey: async () => true,
    appendRun: async () => {},
    finishRun: async () => {},
    listRuns: async () => [],
  };
  const projects = { get: async () => project } as unknown as ProjectRepository;
  const storedWebhook = (id: string): WebhookTrigger => {
    const trigger = stored.get(id);
    if (trigger?.kind !== "webhook") {
      throw new Error(`expected a stored webhook trigger "${id}"`);
    }
    return trigger;
  };
  return {
    stored,
    storedWebhook,
    useCases: createTriggerUseCases({ triggers, projects, cipher: secretCipher }),
  };
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
    const { storedWebhook, useCases } = fixture();
    const created = await useCases.create("p", { triggerId: "t1" }, "owner@example.com");
    expect(storedWebhook("t1").secret).not.toBe(created.secret);
    expect(storedWebhook("t1").secret.startsWith("enc:")).toBe(true);
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

describe("schedule triggers", () => {
  const schedule = {
    triggerId: "nightly",
    kind: "schedule" as const,
    cron: "0 9 * * *",
    timezone: "Asia/Seoul",
    message: "Summarise yesterday.",
  };

  it("creates without a secret and shows its own fields", async () => {
    const { useCases } = fixture();
    const created = await useCases.create("p", schedule, "owner@example.com");
    expect(created.kind).toBe("schedule");
    expect(created.cron).toBe("0 9 * * *");
    expect(created.timezone).toBe("Asia/Seoul");
    expect(created.secret).toBeUndefined();
    expect(created.secretMasked).toBeUndefined();
  });

  it("requires a parseable cron and a real timezone", async () => {
    const { useCases } = fixture();
    for (const bad of [
      { ...schedule, cron: "every day at nine" },
      { ...schedule, timezone: "Mars/Olympus" },
      { triggerId: "nightly", kind: "schedule" as const },
    ]) {
      await expect(useCases.create("p", bad, "owner@example.com")).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it("validates the same rules on update, and can clear the message", async () => {
    const { useCases, stored } = fixture();
    await useCases.create("p", schedule, "owner@example.com");
    await expect(
      useCases.update("p", "nightly", { cron: "61 * * * *" }, "owner@example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
    const updated = await useCases.update(
      "p",
      "nightly",
      { cron: "30 8 * * 1-5", message: "" },
      "owner@example.com",
    );
    expect(updated.cron).toBe("30 8 * * 1-5");
    expect(updated.message).toBeUndefined();
    expect(stored.get("nightly")).not.toHaveProperty("message");
  });

  it("refuses the webhook-only operations", async () => {
    const { useCases } = fixture();
    await useCases.create("p", schedule, "owner@example.com");
    await expect(
      useCases.update("p", "nightly", { rotateSecret: true }, "owner@example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(useCases.reveal("p", "nightly", "owner@example.com")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("refuses schedule fields on a webhook", async () => {
    const { useCases } = fixture();
    await useCases.create("p", { triggerId: "hook" }, "owner@example.com");
    await expect(
      useCases.update("p", "hook", { cron: "0 9 * * *" }, "owner@example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses the other kind's fields on create too, exactly like update", async () => {
    const { useCases, stored } = fixture();
    // cron without kind is a caller who meant kind: "schedule" — silently
    // minting a webhook would leave a schedule that never fires.
    await expect(
      useCases.create("p", { triggerId: "t", cron: "0 9 * * *" }, "owner@example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      useCases.create(
        "p",
        { ...schedule, payloadMode: "message" as const },
        "owner@example.com",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(stored.size).toBe(0);
  });
});
