import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildProjectSlackManifest,
  resolveProjectSlackRuntime as resolveProjectSlackRuntimeImpl,
  updateProjectSlack as updateProjectSlackImpl,
} from "@/application/slack/projectSlack";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";

// The cipher is injected now; every call below is unchanged.
type Upd = Parameters<typeof updateProjectSlackImpl>;
const resolveProjectSlackRuntime = (
  project: Parameters<typeof resolveProjectSlackRuntimeImpl>[1],
) => resolveProjectSlackRuntimeImpl(secretCipher, project);
const updateProjectSlack = (repo: Upd[0], name: Upd[1], update: Upd[2], email: Upd[3]) =>
  updateProjectSlackImpl(repo, name, update, email, secretCipher);
import { decryptSecret } from "@/infrastructure/crypto/secretEncryption";
import { ForbiddenError } from "@/application/errors";
import type { Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";

const OWNER = "t@example.com";
const OTHER = "intruder@example.com";

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
    async publish(p) {
      stored = p;
    },
    async delete() {},
    async getApiToken() {
      return null;
    },
    async setApiToken() {},
    async deleteApiToken() {},
  };
  return { repo, current: () => stored };
}

describe("updateProjectSlack", () => {
  it("encrypts new secrets and masks the response", async () => {
    const { repo, current } = fakeRepo(makeProject());
    const { view } = await updateProjectSlack(
      repo,
      "bot-proj",
      { botToken: "xoxb-secret", signingSecret: "shhh", enabled: true },
      OWNER,
    );
    // 11 chars → two revealed at each end; 4 chars → nothing revealed.
    expect(view.botToken).toBe(`xo${"•".repeat(7)}et`);
    expect(view.signingSecret).toBe("*".repeat("shhh".length));
    expect(view.enabled).toBe(true);
    const stored = current().slack;
    expect(stored?.botToken.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(stored?.botToken ?? "")).toBe("xoxb-secret");
  });

  it("keeps stored secrets when a masked value is echoed back", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await updateProjectSlack(
      repo,
      "bot-proj",
      { botToken: "xoxb-original", signingSecret: "sig-original", enabled: true },
      OWNER,
    );
    const before = current().slack?.botToken;
    await updateProjectSlack(
      repo,
      "bot-proj",
      { botToken: "*".repeat("xoxb-original".length), signingSecret: "", enabled: true },
      OWNER,
    );
    expect(current().slack?.botToken).toBe(before);
    expect(decryptSecret(current().slack?.signingSecret ?? "")).toBe("sig-original");
  });

  it("rejects enabling without credentials", async () => {
    const { repo } = fakeRepo(makeProject());
    await expect(
      updateProjectSlack(repo, "bot-proj", { enabled: true }, OWNER),
    ).rejects.toThrow(/required to enable/);
  });

  it("rejects non-agent projects", async () => {
    const { repo } = fakeRepo(makeProject({ projectType: "llm" }));
    await expect(
      updateProjectSlack(repo, "bot-proj", { botToken: "x", signingSecret: "y" }, OWNER),
    ).rejects.toThrow(/agent projects/);
  });

  it("rejects a non-owner with ForbiddenError (403)", async () => {
    const { repo } = fakeRepo(makeProject());
    await expect(
      updateProjectSlack(repo, "bot-proj", { botToken: "x", signingSecret: "y" }, OTHER),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("resolveProjectSlackRuntime", () => {
  it("returns decrypted credentials only when enabled and configured", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await updateProjectSlack(
      repo,
      "bot-proj",
      { botToken: "xoxb-live", signingSecret: "sig-live", enabled: true },
      OWNER,
    );
    expect(resolveProjectSlackRuntime(current())).toEqual({
      botToken: "xoxb-live",
      signingSecret: "sig-live",
    });
    await updateProjectSlack(repo, "bot-proj", { enabled: false }, OWNER);
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

  it("enables MCP and points the redirect URL at the MCP OAuth callback", () => {
    const manifest = buildProjectSlackManifest(makeProject(), "https://studio.example.com");
    const oauth = manifest.oauth_config as { redirect_urls: string[] };
    const settings = manifest.settings as { is_mcp_enabled: boolean };
    expect(oauth.redirect_urls).toEqual([
      "https://studio.example.com/api/mcps/oauth/callback",
    ]);
    expect(settings.is_mcp_enabled).toBe(true);
  });

  it("subscribes to the event that announces the agent container opening", () => {
    const manifest = buildProjectSlackManifest(makeProject(), "https://studio.example.com");
    const settings = manifest.settings as {
      event_subscriptions: { bot_events: string[] };
    };

    // Without it the panel opens with no prompts and the app looks dead.
    expect(settings.event_subscriptions.bot_events).toContain("app_home_opened");
    // Acting on the channel a user is looking at needs storage that does not
    // exist, so subscribing would only buy traffic.
    expect(settings.event_subscriptions.bot_events).not.toContain("app_context_changed");
  });

  it("describes the agent from the project and carries its prompts", () => {
    const prompts = [{ title: "Draw", message: "Draw me a cat" }];
    const manifest = buildProjectSlackManifest(
      makeProject({
        description: "Paints pictures on request.",
        slack: { botToken: "e", signingSecret: "e", enabled: true, suggestedPrompts: prompts },
      }),
      "https://studio.example.com",
    );
    const features = manifest.features as {
      agent_view: { agent_description: string; suggested_prompts: unknown[] };
    };

    // Slack requires a description once `agent_view` is present, and it is the
    // only text a user sees before asking anything.
    expect(features.agent_view.agent_description).toBe("Paints pictures on request.");
    expect(features.agent_view.suggested_prompts).toEqual(prompts);
  });

  it("falls back to a generated description when the project has none", () => {
    const manifest = buildProjectSlackManifest(makeProject(), "https://studio.example.com");
    const features = manifest.features as { agent_view: { agent_description: string } };

    expect(features.agent_view.agent_description).toContain("bot-proj");
  });

  it("truncates a description Slack would reject", () => {
    const manifest = buildProjectSlackManifest(
      makeProject({ description: "x".repeat(400) }),
      "https://studio.example.com",
    );
    const features = manifest.features as { agent_view: { agent_description: string } };

    expect(features.agent_view.agent_description).toHaveLength(300);
  });
});

describe("suggested prompts", () => {
  const repoFor = () => fakeRepo(makeProject());

  it("drops the editor's blank rows instead of storing them", async () => {
    const { repo, current } = repoFor();

    await updateProjectSlack(
      repo,
      "bot-proj",
      {
        suggestedPrompts: [
          { title: " Draw ", message: " Draw me a cat " },
          { title: "", message: "" },
          { title: "  ", message: "  " },
        ],
      },
      OWNER,
    );

    expect(current().slack?.suggestedPrompts).toEqual([
      { title: "Draw", message: "Draw me a cat" },
    ]);
  });

  it("rejects a prompt missing either half", async () => {
    const { repo } = repoFor();

    await expect(
      updateProjectSlack(repo, "bot-proj", { suggestedPrompts: [{ title: "Draw", message: "" }] }, OWNER),
    ).rejects.toThrow("both a title and a message");
  });

  it("rejects more than Slack accepts", async () => {
    const { repo } = repoFor();
    const prompts = Array.from({ length: 5 }, (_, index) => ({
      title: `T${index}`,
      message: `M${index}`,
    }));

    await expect(
      updateProjectSlack(repo, "bot-proj", { suggestedPrompts: prompts }, OWNER),
    ).rejects.toThrow("at most 4");
  });

  it("leaves stored prompts alone when the update does not mention them", async () => {
    const { repo, current } = repoFor();
    await updateProjectSlack(
      repo,
      "bot-proj",
      { suggestedPrompts: [{ title: "Draw", message: "Draw me a cat" }] },
      OWNER,
    );

    await updateProjectSlack(repo, "bot-proj", { botToken: "xoxb-new" }, OWNER);

    expect(current().slack?.suggestedPrompts).toEqual([
      { title: "Draw", message: "Draw me a cat" },
    ]);
  });
});

describe("what the manifest asks Slack for", () => {
  const events = () => {
    const manifest = buildProjectSlackManifest(makeProject(), "https://studio.example.com");
    return (manifest.settings as { event_subscriptions: { bot_events: string[] } })
      .event_subscriptions.bot_events;
  };
  const scopes = () => {
    const manifest = buildProjectSlackManifest(makeProject(), "https://studio.example.com");
    return (manifest.oauth_config as { scopes: { bot: string[] } }).scopes.bot;
  };

  it("subscribes to channel messages in both kinds of channel", () => {
    // Public and private together: `groups:history` is granted, and taking only
    // the public half would leave follow-ups silently broken in private
    // channels with nothing saying why.
    expect(events()).toContain("message.channels");
    expect(events()).toContain("message.groups");
  });

  it("asks for the scope that resolves a channel name to an id", () => {
    // `channels:history` reads a channel the bot already has the id of.
    // Without `channels:read` "summarise #deploy" cannot even find the channel.
    expect(scopes()).toContain("channels:read");
    expect(scopes()).toContain("channels:history");
  });
});

describe("channel keywords", () => {
  const stored = (project: Project) => project.slack?.channelKeywords;

  it("folds case and drops blanks and duplicates", async () => {
    const { repo, current } = fakeRepo(makeProject());

    await updateProjectSlack(
      repo,
      "bot-proj",
      { channelKeywords: ["Deploy", "  ", "deploy", " 배포 "] },
      OWNER,
    );

    // Case is folded at rest because the list is shown back to the operator —
    // storing `Deploy` and `deploy` separately would display a distinction the
    // matcher does not make.
    expect(stored(current())).toEqual(["deploy", "배포"]);
  });

  it("refuses a keyword too short to be anything but noise", async () => {
    const { repo } = fakeRepo(makeProject());

    await expect(
      updateProjectSlack(repo, "bot-proj", { channelKeywords: ["a"] }, OWNER),
    ).rejects.toThrow(/at least/);
  });

  it("refuses more than the cap", async () => {
    const { repo } = fakeRepo(makeProject());
    const many = Array.from({ length: 21 }, (_, index) => `keyword${index}`);

    await expect(
      updateProjectSlack(repo, "bot-proj", { channelKeywords: many }, OWNER),
    ).rejects.toThrow(/At most/);
  });

  it("keeps what is stored when the update does not mention them", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await updateProjectSlack(repo, "bot-proj", { channelKeywords: ["deploy"] }, OWNER);

    await updateProjectSlack(repo, "bot-proj", { enabled: false }, OWNER);

    expect(stored(current())).toEqual(["deploy"]);
  });

  it("clears them when the update sends an empty list", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await updateProjectSlack(repo, "bot-proj", { channelKeywords: ["deploy"] }, OWNER);

    await updateProjectSlack(repo, "bot-proj", { channelKeywords: [] }, OWNER);

    expect(stored(current())).toBeUndefined();
  });
});
