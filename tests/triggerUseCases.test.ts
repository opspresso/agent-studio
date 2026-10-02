import { memberFixture } from "./memberFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRIGGER_LIST_PAGE_SIZE,
  createTriggerUseCases,
} from "@/application/trigger/triggerUseCases";
import { createTriggerSchema, updateTriggerSchema } from "@/app/api/agents/_lib/schemas";
import { toSlug } from "@/domain/naming";
import { ValidationError } from "@/application/errors";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent } from "@/domain/agent/types";
import type { TriggerRepository } from "@/domain/trigger/repository";
import { AGENT_WEBHOOK_ID, type Trigger, type WebhookTrigger } from "@/domain/trigger/types";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-01-01T00:00:00.000Z");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const agent: Agent = {
  name: "p",
  displayName: "P",
  description: "",
  ownerEmail: "owner@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  configuration: { agentName: "p", systemPrompt: "Review", model: "test", skillList: [], mcpList: [], subagentList: [],
    parameters: { piiFiltering: false, workspaceTools: true } },
};

function fixture(assertReviewReady?: (agentName: string) => Promise<void>, currentAgent: Agent = agent) {
  const stored = new Map<string, Trigger>();
  const triggers: TriggerRepository = {
    get: async (_p, id) => stored.get(id) ?? null,
    listByAgent: async (_agentName, limit, after) =>
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
    updateRunningRun: async () => { throw new Error("CRUD does not dispatch running executions"); },
    listRuns: async () => [],
  };
  const agents = { get: async () => currentAgent } as unknown as AgentRepository;
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
    useCases: createTriggerUseCases({ members: { getById: async id => memberFixture({ id, email: id === "registrar-id" ? agent.ownerEmail : id }) }, triggers, agents, assertReviewReady }),
  };
}

describe("GitHub review trigger configuration", () => {
  it("requires review infrastructure, preserves selection, and lets the owner disable reviews", async () => {
    const authorize = vi.fn(async () => {});
    const f = fixture(authorize);
    const input = { triggerId: "webhook", githubReview: { scope: "accessible" as const } };
    await expect(fixture().useCases.create("p", input, agent.ownerEmail)).rejects.toThrow("not configured");
    const created = await f.useCases.create("p", input, agent.ownerEmail);
    expect(authorize).toHaveBeenCalledExactlyOnceWith("p");
    expect(created.githubReview).toEqual({ scope: "accessible" });
    const next = await f.useCases.update("p", "webhook", { githubReview: {
      scope: "repositories", repositories: ["Example/Agent", "example/agent"],
    } }, agent.ownerEmail);
    expect(next.githubReview).toEqual({ scope: "repositories", repositories: ["example/agent"] });
    expect((await f.useCases.update("p", "webhook", { description: "updated" }, agent.ownerEmail)).githubReview).toEqual(next.githubReview);
    expect((await f.useCases.update("p", "webhook", { githubReview: null }, agent.ownerEmail)).githubReview).toBeUndefined();
  });
  it("refuses invalid repository scopes and review fields on schedules", async () => {
    const f = fixture(async () => {});
    await expect(f.useCases.create("p", { triggerId: "webhook", githubReview: { scope: "repositories", repositories: ["org/*"] } },
      agent.ownerEmail)).rejects.toThrow("exact owner/repo");
    await expect(f.useCases.create("p", { triggerId: "hourly", kind: "schedule", cron: "0 * * * *", timezone: "UTC",
      githubReview: { scope: "accessible" } }, agent.ownerEmail)).rejects.toThrow("only available for webhooks");
    expect(createTriggerSchema.safeParse({ triggerId: "webhook", githubReview: { scope: "accessible", repositories: ["org/repo"] } }).success).toBe(false);
    expect(updateTriggerSchema.safeParse({ githubReview: { scope: "repositories", repositories: [] } }).success).toBe(false);
  });
  it("configures review policy without granting an Agent owner's identity", async () => {
    const f = fixture(async () => {});
    const created = await f.useCases.create("p", { triggerId: "webhook", githubReview: { scope: "accessible" } }, agent.ownerEmail);
    expect(created.githubReview).toEqual({ scope: "accessible" });
    expect(created).not.toHaveProperty("executionEmail");
    expect(created).not.toHaveProperty("secret");
  });
  it.each(["disabled", "blockedTools", "approvalTools"] as const)("refuses PR review setup with %s Workspace tools", async issue => {
    const configured: Agent = { ...agent, configuration: { ...agent.configuration!, parameters: {
      piiFiltering: false, workspaceTools: issue !== "disabled", ...(issue !== "disabled" ? { policy: { [issue]: ["Workspace"] } } : {}),
    } } };
    const f = fixture(async () => {}, configured);
    await expect(f.useCases.create("p", { triggerId: "webhook", githubReview: { scope: "accessible" } }, agent.ownerEmail))
      .rejects.toThrow("Workspace");
    expect(f.stored.size).toBe(0);
  });
  it("reports missing Workspace setup and lets the owner disable reviews", async () => {
    const f = fixture(async () => {}, { ...agent, configuration: { ...agent.configuration!, parameters: { piiFiltering: false } } });
    await f.useCases.create("p", { triggerId: "webhook", enabled: false, githubReview: { scope: "accessible" } }, agent.ownerEmail);
    expect((await f.useCases.list("p", agent.ownerEmail))[0]?.reviewIssue).toContain("Workspace");
    await expect(f.useCases.update("p", "webhook", { enabled: true }, agent.ownerEmail)).rejects.toThrow("Workspace");
    expect((await f.useCases.update("p", "webhook", { githubReview: null }, agent.ownerEmail)).reviewIssue).toBeUndefined();
  });
});

describe("trigger execution permissions", () => {
  it("captures the registering user ID and preserves it across edits", async () => {
    const f = fixture();
    const created = await f.useCases.create("p", { triggerId: "hourly", kind: "schedule", cron: "0 * * * *",
      timezone: "Asia/Seoul" }, "registrar-id");
    expect(created.createdBy).toEqual({ userId: "registrar-id", email: agent.ownerEmail });
    expect(created).not.toHaveProperty("executionEmail");
    const edited = await f.useCases.update("p", "hourly", { message: "updated" }, agent.ownerEmail);
    expect(edited.createdBy).toEqual(created.createdBy);
    expect(edited.updatedAt).not.toBe(created.updatedAt);
    expect(updateTriggerSchema.safeParse({ runAsOwner: false }).success).toBe(false);
    expect(createTriggerSchema.safeParse({ triggerId: "x", kind: "schedule", createdBy: { userId: "other" } }).success).toBe(false);
    expect(updateTriggerSchema.safeParse({ createdBy: { userId: "other" } }).success).toBe(false);
  });

  it("rejects owner delegation and shared secret controls at the HTTP contract", () => {
    for (const input of [{ runAsOwner: true }, { executionEmail: "other@example.test" }, { rotateSecret: true }]) {
      expect(createTriggerSchema.safeParse({ triggerId: "webhook", ...input }).success).toBe(false);
      expect(updateTriggerSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("trigger ids follow the agent-name rule", () => {
  it("normalises the same way an agent name does", () => {
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

describe("an agent has exactly one webhook", () => {
  it("refuses a webhook under any name but the agent's own", async () => {
    // `/api/webhook/{agent}` is the only delivery address there is, and it
    // resolves `AGENT_WEBHOOK_ID`. A webhook created under another name would
    // be a minted secret with no door to open.
    const { useCases } = fixture();
    await expect(
      useCases.create("p", { triggerId: "nightly" }, "owner@example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
    const created = await useCases.create(
      "p",
      { triggerId: AGENT_WEBHOOK_ID },
      "owner@example.com",
    );
    expect(created.kind).toBe("webhook");
    expect(created).not.toHaveProperty("secret");
  });
});

describe("shared Webhook configuration", () => {
  it("returns settings without personal credentials on creation, updates and reads", async () => {
    const { useCases } = fixture();
    const created = await useCases.create("p", { triggerId: AGENT_WEBHOOK_ID }, "owner@example.com");
    const updated = await useCases.update("p", AGENT_WEBHOOK_ID, { enabled: false }, "owner@example.com");
    const listed = await useCases.list("p", "owner@example.com");
    expect(created.enabled).toBe(true); expect(updated.enabled).toBe(false);
    for (const view of [created, updated, ...listed]) {
      expect(view).not.toHaveProperty("secret"); expect(view).not.toHaveProperty("secretMasked"); expect(view).not.toHaveProperty("executionEmail");
    }
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
        agentName: "p",
        triggerId,
        kind: "schedule",
        createdBy: { userId: "registrar-id", email: "registrar@example.test" },
        description: "",
        enabled: true,
        cron: "0 9 * * *",
        timezone: "Asia/Seoul",
        allowConcurrent: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    }
    const listByAgent = triggers.listByAgent.bind(triggers);
    const pageSizes: number[] = [];
    triggers.listByAgent = async (agentName, limit, after) => {
      const page = await listByAgent(agentName, limit, after);
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
    expect(created).not.toHaveProperty("secret");
    expect(created).not.toHaveProperty("secretMasked");
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


  it("may not take the id the agent's own webhook is addressed by", async () => {
    // `/api/webhook/{agent}` resolves that id and expects a webhook. A schedule
    // sitting on it would 404 an agent whose console shows a webhook.
    const { useCases } = fixture();
    await expect(
      useCases.create("p", { ...schedule, triggerId: AGENT_WEBHOOK_ID }, "owner@example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses schedule fields on a webhook", async () => {
    const { useCases } = fixture();
    await useCases.create("p", { triggerId: AGENT_WEBHOOK_ID }, "owner@example.com");
    await expect(
      useCases.update("p", AGENT_WEBHOOK_ID, { cron: "0 9 * * *" }, "owner@example.com"),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      useCases.update(
        "p",
        AGENT_WEBHOOK_ID,
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
        { triggerId: AGENT_WEBHOOK_ID, cron: "0 9 * * *" },
        "owner@example.com",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(stored.size).toBe(0);
  });
});

describe("Agent trigger input schema", () => {
  it.each([{ variables: { topic: "test" } }, { payloadMode: "variables" }, { payloadMode: "message" }])(
    "refuses retired template fields instead of ignoring them: %j", fields => {
      expect(createTriggerSchema.safeParse({ triggerId: AGENT_WEBHOOK_ID, ...fields }).success).toBe(false);
      expect(updateTriggerSchema.safeParse(fields).success).toBe(false);
    },
  );
});
