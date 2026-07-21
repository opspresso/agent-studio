import { beforeAll, describe, expect, it } from "vitest";
import {
  buildProjectSlackManifest,
  resolveProjectSlackRuntime,
  updateProjectSlack,
} from "@/application/slack/projectSlack";
import { MASKED_SECRET, decryptSecret } from "@/lib/secret-encryption";
import type { Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";

beforeAll(() => {
  process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: "bot-proj",
    displayName: "Bot Project",
    description: "",
    projectType: "agent",
    ownerEmail: "t@example.com",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fakeRepo(initial: Project): { repo: ProjectRepository; current: () => Project } {
  let stored = initial;
  const repo: ProjectRepository = {
    async get(name) {
      return name === stored.name ? stored : null;
    },
    async list() {
      return [stored];
    },
    async create(p) {
      stored = p;
    },
    async update(p) {
      stored = p;
    },
    async delete() {},
  };
  return { repo, current: () => stored };
}

describe("updateProjectSlack", () => {
  it("encrypts new secrets and masks the response", async () => {
    const { repo, current } = fakeRepo(makeProject());
    const view = await updateProjectSlack(repo, "bot-proj", {
      botToken: "xoxb-secret",
      signingSecret: "shhh",
      enabled: true,
    });
    expect(view.botToken).toBe(MASKED_SECRET);
    expect(view.signingSecret).toBe(MASKED_SECRET);
    expect(view.enabled).toBe(true);
    const stored = current().slack;
    expect(stored?.botToken.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(stored?.botToken ?? "")).toBe("xoxb-secret");
  });

  it("keeps stored secrets when a masked value is echoed back", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await updateProjectSlack(repo, "bot-proj", {
      botToken: "xoxb-original",
      signingSecret: "sig-original",
      enabled: true,
    });
    const before = current().slack?.botToken;
    await updateProjectSlack(repo, "bot-proj", {
      botToken: MASKED_SECRET,
      signingSecret: "",
      enabled: true,
    });
    expect(current().slack?.botToken).toBe(before);
    expect(decryptSecret(current().slack?.signingSecret ?? "")).toBe("sig-original");
  });

  it("rejects enabling without credentials", async () => {
    const { repo } = fakeRepo(makeProject());
    await expect(
      updateProjectSlack(repo, "bot-proj", { enabled: true }),
    ).rejects.toThrow(/required to enable/);
  });

  it("rejects non-agent projects", async () => {
    const { repo } = fakeRepo(makeProject({ projectType: "llm" }));
    await expect(
      updateProjectSlack(repo, "bot-proj", { botToken: "x", signingSecret: "y" }),
    ).rejects.toThrow(/agent projects/);
  });
});

describe("resolveProjectSlackRuntime", () => {
  it("returns decrypted credentials only when enabled and configured", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await updateProjectSlack(repo, "bot-proj", {
      botToken: "xoxb-live",
      signingSecret: "sig-live",
      enabled: true,
    });
    expect(resolveProjectSlackRuntime(current())).toEqual({
      botToken: "xoxb-live",
      signingSecret: "sig-live",
    });
    await updateProjectSlack(repo, "bot-proj", { enabled: false });
    expect(resolveProjectSlackRuntime(current())).toBeNull();
    expect(resolveProjectSlackRuntime(makeProject())).toBeNull();
  });
});

describe("buildProjectSlackManifest", () => {
  it("points the events URL at the per-project path", () => {
    const manifest = buildProjectSlackManifest(makeProject(), "https://studio.example.com");
    const settings = manifest.settings as {
      event_subscriptions: { request_url: string; bot_events: string[] };
    };
    expect(settings.event_subscriptions.request_url).toBe(
      "https://studio.example.com/api/slack/events/bot-proj",
    );
    expect(settings.event_subscriptions.bot_events).toContain("app_mention");
  });
});
