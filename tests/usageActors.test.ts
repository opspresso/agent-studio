import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_ACTOR_USAGE_ROWS,
  MAX_ACTOR_VIEWS,
  listProjectActors,
  type ListActorsDeps,
} from "@/application/usage/listActors";
import { resolveProjectSlackRuntime } from "@/application/slack/projectSlack";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import type { RunCaller } from "@/domain/execution/actor";
import type { Project } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";
import type { ActorUsageRow } from "@/domain/usage/types";
import { slackSecretContext } from "@/domain/security/secretContext";

beforeAll(() => {
  process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
});

function makeProject(withSlack: boolean): Project {
  return {
    name: "painter",
    displayName: "Painter",
    description: "",
    ownerEmail: "owner@x.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(withSlack
      ? {
          slack: {
            botToken: secretCipher.encrypt(
              "xoxb-token",
              slackSecretContext("painter", "bot-token"),
            ),
            signingSecret: secretCipher.encrypt(
              "secret",
              slackSecretContext("painter", "signing-secret"),
            ),
            enabled: true,
          },
        }
      : {}),
  };
}

function row(actor: string, calls = 2, cost = 0.5): ActorUsageRow {
  return {
    projectName: "painter",
    date: "2026-07-30",
    actor,
    calls: { "gpt-5": calls },
    inputTokens: { "gpt-5": 100 },
    outputTokens: { "gpt-5": 50 },
    costUsd: { "gpt-5": cost },
  };
}

function makeDeps(
  rows: ActorUsageRow[],
  resolveSlackProfile: (botToken: string, userId: string) => Promise<RunCaller | null>,
): ListActorsDeps {
  return {
    usage: { listActorsByProject: async () => rows } as unknown as UsageRepository,
    // The composition root's closure, spelled out: the reader is bound to the
    // project's own decrypted token, or absent when it has no enabled bot.
    profileReaderFor: (project) => {
      const runtime = resolveProjectSlackRuntime(secretCipher, project);
      return runtime ? (userId) => resolveSlackProfile(runtime.botToken, userId) : null;
    },
  };
}

describe("listProjectActors", () => {
  it("puts a name and an avatar on a Slack caller", async () => {
    const resolve = vi.fn(async () => ({
      displayName: "Bruce",
      avatarUrl: "https://x/512.png",
    }));

    const result = await listProjectActors(
      makeDeps([row("slack:U1")], resolve),
      makeProject(true),
      "2026-07-01",
      "2026-07-31",
    );

    expect(resolve).toHaveBeenCalledWith("xoxb-token", "U1");
    expect(result.items[0]?.display).toEqual({ name: "Bruce", avatarUrl: "https://x/512.png" });
    // The key stays exactly as stored: a client telling two callers apart must
    // not have to parse a display name.
    expect(result.items[0]?.actor).toBe("slack:U1");
    expect(result).toMatchObject({ totalActors: 1, truncated: false });
  });

  it("resolves each distinct user once, however many days they span", async () => {
    const resolve = vi.fn(async () => ({ displayName: "Bruce" }));

    await listProjectActors(
      makeDeps([row("slack:U1"), { ...row("slack:U1"), date: "2026-07-29" }], resolve),
      makeProject(true),
      "2026-07-01",
      "2026-07-31",
    );

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("leaves non-Slack callers alone", async () => {
    const resolve = vi.fn(async () => ({ displayName: "Bruce" }));

    const result = await listProjectActors(
      makeDeps([row("user:someone@example.com"), row("webhook:project:trigger")], resolve),
      makeProject(true),
      "2026-07-01",
      "2026-07-31",
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(result.items.every((item) => item.display === undefined)).toBe(true);
  });

  it("returns the raw keys when the project has no Slack bot", async () => {
    const resolve = vi.fn(async () => ({ displayName: "Bruce" }));

    const result = await listProjectActors(
      makeDeps([row("slack:U1")], resolve),
      makeProject(false),
      "2026-07-01",
      "2026-07-31",
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(result.items[0]?.display).toBeUndefined();
  });

  it("still answers when the lookup throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolve = vi.fn(async () => {
      throw new Error("slack is down");
    });

    const result = await listProjectActors(
      makeDeps([row("slack:U1")], resolve),
      makeProject(true),
      "2026-07-01",
      "2026-07-31",
    );

    // A Slack outage must not take the cost dashboard down with it.
    expect(result.items[0]?.actor).toBe("slack:U1");
    expect(result.items[0]?.display).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("aggregates an actor before ranking and enriching it", async () => {
    const resolve = vi.fn(async () => ({ displayName: "Bruce" }));

    const result = await listProjectActors(
      makeDeps([row("slack:U1"), { ...row("slack:U1", 3, 0.75), date: "2026-07-29" }], resolve),
      makeProject(true),
      "2026-07-01",
      "2026-07-31",
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      calls: { "gpt-5": 5 },
      costUsd: { "gpt-5": 1.25 },
    });
  });

  it("returns and enriches only the highest-cost callers", async () => {
    const resolve = vi.fn(async (token: string, userId: string) => ({
      displayName: `${token}:${userId}`,
    }));
    const rows = Array.from({ length: MAX_ACTOR_VIEWS + 5 }, (_, index) =>
      row(`slack:U${String(index).padStart(3, "0")}`, 1, index),
    );

    const result = await listProjectActors(
      makeDeps(rows, resolve),
      makeProject(true),
      "2026-07-01",
      "2026-07-31",
    );

    expect(result.items).toHaveLength(MAX_ACTOR_VIEWS);
    expect(result.totalActors).toBe(MAX_ACTOR_VIEWS + 5);
    expect(result.truncated).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(MAX_ACTOR_VIEWS);
    expect(result.items[0]?.actor).toBe(`slack:U${MAX_ACTOR_VIEWS + 4}`);
  });

  it("refuses a range whose raw actor rows exceed the read cap", async () => {
    const rows = Array.from({ length: MAX_ACTOR_USAGE_ROWS + 1 }, (_, index) =>
      row(`user:${index}`),
    );

    await expect(
      listProjectActors(
        makeDeps(rows, async () => null),
        makeProject(false),
        "2026-01-01",
        "2026-07-03",
      ),
    ).rejects.toThrow("choose a narrower date range");
  });
});
