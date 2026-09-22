import { describe, expect, it, vi } from "vitest";
import {
  TRIGGER_LIST_PAGE_SIZE,
  createTriggerUseCases,
} from "@/application/trigger/triggerUseCases";
import { createTriggerSchema, updateTriggerSchema } from "@/app/api/projects/_lib/schemas";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { toSlug } from "@/domain/naming";
import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project } from "@/domain/project/types";
import type { TriggerRepository } from "@/domain/trigger/repository";
import { PROJECT_WEBHOOK_ID, type Trigger, type WebhookTrigger } from "@/domain/trigger/types";

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
    listByProject: async (_projectName, limit, after) =>
      [...stored.values()]
        .sort((a, b) => a.triggerId.localeCompare(b.triggerId))
        .filter((trigger) => !after || trigger.triggerId > after)
        .slice(0, limit),
    listSchedules: async () =>
      [...stored.values()].filter((t) => t.kind === "schedule"),
    create: async (t) => void stored.set(t.triggerId, t),
    put: async (t) => void stored.set(t.triggerId, t),
    delete: async (_p, id) => void stored.delete(id),
    claimIdempotencyKey: async () => true,
    appendRun: async () => {},
    finishRun: async () => {},
    updateQueuedRun: async () => { throw new Error("CRUD does not dispatch queued runs"); },
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
    triggers,
    storedWebhook,
    useCases: createTriggerUseCases({ triggers, projects, cipher: secretCipher }),
  };
}

describe("schedule personal execution", () => {
  it("captures the authenticated owner's email and can explicitly clear it", async () => {
    const f = fixture();
    const created = await f.useCases.create("p", { triggerId: "hourly", kind: "schedule", cron: "0 * * * *",
      timezone: "Asia/Seoul", runAsOwner: true }, project.ownerEmail);
    expect(created.executionEmail).toBe(project.ownerEmail);
    expect((await f.useCases.update("p", "hourly", { message: "updated" }, project.ownerEmail)).executionEmail).toBe(project.ownerEmail);
    expect((await f.useCases.update("p", "hourly", { runAsOwner: false }, project.ownerEmail)).executionEmail).toBeUndefined();
  });
  it("refuses personal execution on webhooks", async () => {
    const f = fixture();
    await expect(f.useCases.create("p", { triggerId: "webhook", runAsOwner: true }, project.ownerEmail)).rejects.toThrow("only available for schedules");
  });
});

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

describe("a project has exactly one webhook", () => {
  it("refuses a webhook under any name but the project's own", async () => {
    // `/api/webhook/{project}` is the only delivery address there is, and it
    // resolves `PROJECT_WEBHOOK_ID`. A webhook created under another name would
    // be a minted secret with no door to open.
    const { useCases } = fixture();
    await expect(
      useCases.create("p", { triggerId: "nightly" }, "owner@example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
    const created = await useCases.create(
      "p",
      { triggerId: PROJECT_WEBHOOK_ID },
      "owner@example.com",
    );
    expect(created.kind).toBe("webhook");
    expect(created.secret).toBeTruthy();
  });
});

describe("trigger secret", () => {
  it("comes back in the clear once on create, and masked afterwards", async () => {
    const { useCases } = fixture();
    const created = await useCases.create(
      "p",
      { triggerId: PROJECT_WEBHOOK_ID },
      "owner@example.com",
    );
    expect(created.secret).toMatch(/^asw_/);
    const [listed] = await useCases.list("p", "owner@example.com");
    expect(listed?.secret).toBeUndefined();
    expect(listed?.secretMasked).toMatch(/^asw_•+/);
  });

  it("is stored encrypted, never in plaintext", async () => {
    const { storedWebhook, useCases } = fixture();
    const created = await useCases.create(
      "p",
      { triggerId: PROJECT_WEBHOOK_ID },
      "owner@example.com",
    );
    expect(storedWebhook(PROJECT_WEBHOOK_ID).secret).not.toBe(created.secret);
    expect(storedWebhook(PROJECT_WEBHOOK_ID).secret.startsWith("enc:v2:")).toBe(true);
  });

  it("can be read back, like a project API token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { useCases } = fixture();
    const created = await useCases.create(
      "p",
      { triggerId: PROJECT_WEBHOOK_ID },
      "owner@example.com",
    );
    const revealed = await useCases.reveal("p", PROJECT_WEBHOOK_ID, "owner@example.com");
    expect(revealed.secret).toBe(created.secret);
    // Secret access leaves a trail even when it is authorized.
    expect(warn.mock.calls.some(([line]) => String(line).includes("revealed by"))).toBe(true);
    warn.mockRestore();
  });

  it("refuses a reveal to anyone but the owner or an admin", async () => {
    const { useCases } = fixture();
    await useCases.create("p", { triggerId: PROJECT_WEBHOOK_ID }, "owner@example.com");
    await expect(
      useCases.reveal("p", PROJECT_WEBHOOK_ID, "someone@example.com"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("404s a reveal for a trigger that does not exist", async () => {
    const { useCases } = fixture();
    await expect(useCases.reveal("p", "nope", "owner@example.com")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("regenerating returns the new secret once and invalidates the old", async () => {
    const { useCases } = fixture();
    const created = await useCases.create(
      "p",
      { triggerId: PROJECT_WEBHOOK_ID },
      "owner@example.com",
    );
    const rotated = await useCases.update(
      "p",
      PROJECT_WEBHOOK_ID,
      { rotateSecret: true },
      "owner@example.com",
    );
    expect(rotated.secret).toMatch(/^asw_/);
    expect(rotated.secret).not.toBe(created.secret);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await useCases.reveal("p", PROJECT_WEBHOOK_ID, "owner@example.com")).secret).toBe(
      rotated.secret,
    );
    warn.mockRestore();
  });

  it("an ordinary update leaves the secret alone", async () => {
    const { useCases } = fixture();
    const created = await useCases.create(
      "p",
      { triggerId: PROJECT_WEBHOOK_ID },
      "owner@example.com",
    );
    const updated = await useCases.update(
      "p",
      PROJECT_WEBHOOK_ID,
      { enabled: false },
      "owner@example.com",
    );
    expect(updated.secret).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await useCases.reveal("p", PROJECT_WEBHOOK_ID, "owner@example.com")).secret).toBe(
      created.secret,
    );
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

  it("lists every trigger through bounded repository pages", async () => {
    const { stored, triggers, useCases } = fixture();
    for (let index = 0; index < TRIGGER_LIST_PAGE_SIZE + 2; index += 1) {
      const triggerId = `schedule-${String(index).padStart(3, "0")}`;
      stored.set(triggerId, {
        projectName: "p",
        triggerId,
        kind: "schedule",
        description: "",
        enabled: true,
        cron: "0 9 * * *",
        timezone: "Asia/Seoul",
        allowConcurrent: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    }
    const listByProject = triggers.listByProject.bind(triggers);
    const pageSizes: number[] = [];
    triggers.listByProject = async (projectName, limit, after) => {
      const page = await listByProject(projectName, limit, after);
      pageSizes.push(page.length);
      return page;
    };

    await expect(useCases.list("p", "owner@example.com")).resolves.toHaveLength(stored.size);
    expect(pageSizes).toEqual([TRIGGER_LIST_PAGE_SIZE, 2]);
  });

  it("creates without a secret and shows its own fields", async () => {
    const { useCases } = fixture();
    const created = await useCases.create("p", schedule, "owner@example.com");
    expect(created.kind).toBe("schedule");
    expect(created.cron).toBe("0 9 * * *");
    expect(created.timezone).toBe("Asia/Seoul");
    expect(created.secret).toBeUndefined();
    expect(created.secretMasked).toBeUndefined();
  });

  it("stores one report destination for each messaging platform", async () => {
    const { useCases, stored } = fixture();
    const deliveries = [
      { kind: "slack" as const, channelId: " C123 " },
      { kind: "telegram" as const, chatId: -100123, threadId: 7 },
      { kind: "teams" as const, conversationId: " 19:meeting " },
    ];
    const created = await useCases.create(
      "p",
      { ...schedule, deliveries },
      "owner@example.com",
    );
    expect(created.deliveries).toEqual([
      { kind: "slack", channelId: "C123" },
      { kind: "telegram", chatId: -100123, threadId: 7 },
      { kind: "teams", conversationId: "19:meeting" },
    ]);
    expect(stored.get("nightly")).toMatchObject({ deliveries: created.deliveries });
  });

  it("rejects duplicate platforms and clears destinations with an empty list", async () => {
    const { useCases, stored } = fixture();
    await expect(
      useCases.create(
        "p",
        {
          ...schedule,
          deliveries: [
            { kind: "slack", channelId: "C1" },
            { kind: "slack", channelId: "C2" },
          ],
        },
        "owner@example.com",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await useCases.create(
      "p",
      { ...schedule, deliveries: [{ kind: "slack", channelId: "C1" }] },
      "owner@example.com",
    );
    const updated = await useCases.update(
      "p",
      "nightly",
      { deliveries: [] },
      "owner@example.com",
    );
    expect(updated.deliveries).toBeUndefined();
    expect(stored.get("nightly")).not.toHaveProperty("deliveries");
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

  it("may not take the id the project's own webhook is addressed by", async () => {
    // `/api/webhook/{project}` resolves that id and expects a webhook. A schedule
    // sitting on it would 404 a project whose console shows a webhook.
    const { useCases } = fixture();
    await expect(
      useCases.create("p", { ...schedule, triggerId: PROJECT_WEBHOOK_ID }, "owner@example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses schedule fields on a webhook", async () => {
    const { useCases } = fixture();
    await useCases.create("p", { triggerId: PROJECT_WEBHOOK_ID }, "owner@example.com");
    await expect(
      useCases.update("p", PROJECT_WEBHOOK_ID, { cron: "0 9 * * *" }, "owner@example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      useCases.update(
        "p",
        PROJECT_WEBHOOK_ID,
        { deliveries: [{ kind: "slack", channelId: "C1" }] },
        "owner@example.com",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses the other kind's fields on create too, exactly like update", async () => {
    const { useCases, stored } = fixture();
    // cron without kind is a caller who meant kind: "schedule" — silently
    // minting a webhook would leave a schedule that never fires.
    await expect(
      useCases.create(
        "p",
        { triggerId: PROJECT_WEBHOOK_ID, cron: "0 9 * * *" },
        "owner@example.com",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(stored.size).toBe(0);
  });
});

describe("Agent trigger input schema", () => {
  it.each([{ variables: { topic: "test" } }, { payloadMode: "variables" }, { payloadMode: "message" }])(
    "refuses retired template fields instead of ignoring them: %j", fields => {
      expect(createTriggerSchema.safeParse({ triggerId: PROJECT_WEBHOOK_ID, ...fields }).success).toBe(false);
      expect(updateTriggerSchema.safeParse(fields).success).toBe(false);
    },
  );
});
