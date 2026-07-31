import { beforeAll, describe, expect, it, vi } from "vitest";
import { listProjectActors, type ListActorsDeps } from "@/application/usage/listActors";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import type { Project } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";
import type { ActorUsageRow } from "@/domain/usage/types";

beforeAll(() => {
  process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
});

function makeProject(withSlack: boolean): Project {
  return {
    name: "painter",
    displayName: "Painter",
    description: "",
    projectType: "agent",
    ownerEmail: "owner@x.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(withSlack
      ? {
          slack: {
            botToken: secretCipher.encrypt("xoxb-token"),
            signingSecret: secretCipher.encrypt("secret"),
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
  resolveSlackProfile: ListActorsDeps["resolveSlackProfile"],
): ListActorsDeps {
  return {
    usage: { listActorsByProject: async () => rows } as unknown as UsageRepository,
    cipher: secretCipher,
    resolveSlackProfile,
  };
}

describe("listProjectActors", () => {
  it("puts a name and an avatar on a Slack caller", async () => {
    const resolve = vi.fn(async () => ({
      displayName: "Bruce",
      avatarUrl: "https://x/512.png",
    }));

    const items = await listProjectActors(
      makeDeps([row("slack:U1")], resolve),
      makeProject(true),
      "2026-07-01",
      "2026-07-31",
    );

    expect(resolve).toHaveBeenCalledWith("xoxb-token", "U1");
    expect(items[0]?.display).toEqual({ name: "Bruce", avatarUrl: "https://x/512.png" });
    // The key stays exactly as stored: a client telling two callers apart must
    // not have to parse a display name.
    expect(items[0]?.actor).toBe("slack:U1");
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

    const items = await listProjectActors(
      makeDeps([row("user:someone@example.com"), row("a2a:shared-key")], resolve),
      makeProject(true),
      "2026-07-01",
      "2026-07-31",
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(items.every((item) => item.display === undefined)).toBe(true);
  });

  it("returns the raw keys when the project has no Slack bot", async () => {
    const resolve = vi.fn(async () => ({ displayName: "Bruce" }));

    const items = await listProjectActors(
      makeDeps([row("slack:U1")], resolve),
      makeProject(false),
      "2026-07-01",
      "2026-07-31",
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(items[0]?.display).toBeUndefined();
  });

  it("still answers when the lookup throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolve = vi.fn(async () => {
      throw new Error("slack is down");
    });

    const items = await listProjectActors(
      makeDeps([row("slack:U1")], resolve),
      makeProject(true),
      "2026-07-01",
      "2026-07-31",
    );

    // A Slack outage must not take the cost dashboard down with it.
    expect(items[0]?.actor).toBe("slack:U1");
    expect(items[0]?.display).toBeUndefined();
    vi.restoreAllMocks();
  });
});
