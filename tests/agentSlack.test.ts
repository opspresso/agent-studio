import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSlackManifest,
  createAgentSlackUseCases,
  resolveAgentSlackRuntime as resolveAgentSlackRuntimeImpl,
  updateAgentSlack as updateAgentSlackImpl,
} from "@/application/slack/agentSlack";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { slackClient } from "@/infrastructure/slack/client";

// Exercise the production cipher through the injected boundary.
type Upd = Parameters<typeof updateAgentSlackImpl>;
const resolveAgentSlackRuntime = (
  agent: Parameters<typeof resolveAgentSlackRuntimeImpl>[1],
) => resolveAgentSlackRuntimeImpl(secretCipher, agent);
const updateAgentSlack = (repo: Upd[0], name: Upd[1], update: Upd[2], email: Upd[3]) =>
  updateAgentSlackImpl(repo, name, update, email, secretCipher, "owner-user-id");
import { decryptSecret } from "@/infrastructure/crypto/secretEncryption";
import { slackSecretContext } from "@/domain/security/secretContext";
import { ConflictError, ForbiddenError } from "@/application/errors";
import type { Agent } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";

const OWNER = "t@example.com";
const OTHER = "intruder@example.com";

// Distinct fixture bytes exercise rotation without sampling real randomness.
const entropy = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomBytes: (size: number) => {
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(++entropy.sequence);
    return bytes;
  },
}));

beforeEach(() => {
  entropy.sequence = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-01-02T00:00:00.000Z");
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: "bot-proj",
    displayName: "Bot Agent",
    description: "",
    ownerEmail: "t@example.com",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fakeRepo(initial: Agent): { repo: AgentRepository; current: () => Agent } {
  let stored = initial;
  const repo: AgentRepository = {
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

describe("updateAgentSlack", () => {

  it("encrypts new secrets and masks the response", async () => {
    const { repo, current } = fakeRepo(makeAgent());
    const { view } = await updateAgentSlack(
      repo,
      "bot-proj",
      { botToken: "xoxb-secret", signingSecret: "shhh", enabled: true },
      OWNER,
    );
    // 11 chars → four revealed at each end; 4 chars → nothing revealed.
    expect(view.botToken).toBe(`xoxb${"•".repeat(3)}cret`);
    expect(view.signingSecret).toBe("*".repeat("shhh".length));
    expect(view.enabled).toBe(true);
    const stored = current().slack;
    expect(stored?.botToken.startsWith("enc:v2:")).toBe(true);
    expect(
      decryptSecret(stored?.botToken ?? "", slackSecretContext("bot-proj", "bot-token")),
    ).toBe("xoxb-secret");
  });

  it("keeps stored secrets when a masked value is echoed back", async () => {
    const { repo, current } = fakeRepo(makeAgent());
    await updateAgentSlack(
      repo,
      "bot-proj",
      { botToken: "xoxb-original", signingSecret: "sig-original", enabled: true },
      OWNER,
    );
    const before = current().slack?.botToken;
    await updateAgentSlack(
      repo,
      "bot-proj",
      { botToken: "*".repeat("xoxb-original".length), signingSecret: "", enabled: true },
      OWNER,
    );
    expect(current().slack?.botToken).toBe(before);
    expect(
      decryptSecret(
        current().slack?.signingSecret ?? "",
        slackSecretContext("bot-proj", "signing-secret"),
      ),
    ).toBe("sig-original");
  });

  it("rejects enabling without credentials", async () => {
    const { repo } = fakeRepo(makeAgent());
    await expect(
      updateAgentSlack(repo, "bot-proj", { enabled: true }, OWNER),
    ).rejects.toThrow(/required to enable/);
  });

  it("rejects a non-owner with ForbiddenError (403)", async () => {
    const { repo } = fakeRepo(makeAgent());
    await expect(
      updateAgentSlack(repo, "bot-proj", { botToken: "x", signingSecret: "y" }, OTHER),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("maps a stale agent snapshot to ConflictError", async () => {
    const { repo } = fakeRepo(makeAgent());
    repo.update = async () => {
      throw Object.assign(new Error("conditional check failed"), {
        name: "ConditionalWriteFailed",
      });
    };

    await expect(
      updateAgentSlack(repo, "bot-proj", { botToken: "x", signingSecret: "y" }, OWNER),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("resolveAgentSlackRuntime", () => {
  it("returns decrypted credentials only when enabled and configured", async () => {
    const { repo, current } = fakeRepo(makeAgent());
    await updateAgentSlack(
      repo,
      "bot-proj",
      { botToken: "xoxb-live", signingSecret: "sig-live", enabled: true },
      OWNER,
    );
    expect(resolveAgentSlackRuntime(current())).toEqual({
      botToken: "xoxb-live",
      signingSecret: "sig-live",
    });
    await updateAgentSlack(repo, "bot-proj", { enabled: false }, OWNER);
    expect(resolveAgentSlackRuntime(current())).toBeNull();
    expect(resolveAgentSlackRuntime(makeAgent())).toBeNull();
  });

  it("refuses credentials moved under another agent name", async () => {
    const { repo, current } = fakeRepo(makeAgent());
    await updateAgentSlack(
      repo,
      "bot-proj",
      { botToken: "xoxb-live", signingSecret: "sig-live", enabled: true },
      OWNER,
    );

    expect(() => resolveAgentSlackRuntime({ ...current(), name: "other" })).toThrow();
  });
});

describe("schedule channel choices", () => {
  it("lists only channels the agent bot has joined, sorted by name", async () => {
    const { repo } = fakeRepo(makeAgent());
    await updateAgentSlack(
      repo,
      "bot-proj",
      { botToken: "xoxb-live", signingSecret: "sig-live", enabled: true },
      OWNER,
    );
    const calls: unknown[] = [];
    const useCases = createAgentSlackUseCases({
      agents: repo,
      cipher: secretCipher,
      authTest: async () => ({}),
      listChannels: async (token, args) => {
        calls.push({ token, args });
        return { channels: [
          { id: "C2", name: "zeta", isMember: true },
          { id: "C1", name: "alpha", isMember: true },
        ], truncated: true };
      },
    });
    expect(await useCases.channels("bot-proj", OWNER)).toEqual({ channels: [
      { id: "C1", name: "alpha", isMember: true },
      { id: "C2", name: "zeta", isMember: true },
    ], truncated: true });
    expect(calls).toEqual([{ token: "xoxb-live", args: { limit: 200, memberOnly: true } }]);
    await expect(useCases.channels("bot-proj", OTHER)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps later-page joined channels available to notification selectors", async () => {
    const { repo } = fakeRepo(makeAgent());
    await updateAgentSlack(repo, "bot-proj", { botToken: "xoxb-live", signingSecret: "sig-live", enabled: true }, OWNER);
    const request = vi.fn(async (url: string) => {
      const first = !new URL(url).searchParams.has("cursor");
      return new Response(JSON.stringify({ ok: true,
        channels: first ? [{ id: "C1", name: "unjoined", is_member: false }]
          : [{ id: "C2", name: "alerts", is_member: true }],
        response_metadata: { next_cursor: first ? "next" : "" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", request);
    const useCases = createAgentSlackUseCases({ agents: repo, cipher: secretCipher,
      authTest: async () => ({}), listChannels: slackClient.listChannels });

    expect(await useCases.channels("bot-proj", OWNER)).toEqual({
      channels: [{ id: "C2", name: "alerts", isMember: true }], truncated: false,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("buildAgentSlackManifest", () => {
  it.each([34, 79, 139, 299])("keeps every manifest text field well formed at Unicode boundary %i", (prefix) => {
    const text = "x".repeat(prefix) + "😀";
    const manifest = buildAgentSlackManifest(makeAgent({ displayName: text, description: text }), "https://studio.example.com");
    const display = manifest.display_information as { name: string; description: string };
    const features = manifest.features as { bot_user: { display_name: string }; agent_view: { agent_description: string } };
    for (const value of [display.name, display.description, features.bot_user.display_name, features.agent_view.agent_description]) {
      expect(value.isWellFormed()).toBe(true);
    }
  });

  it("uses the selected service name for a generated description", () => {
    const manifest = buildAgentSlackManifest(makeAgent(), "https://studio.example.com", "AgentOps");
    expect((manifest.display_information as { description: string }).description).toBe("AgentOps bot for the bot-proj agent");
  });

  it("points the events URL at the per-agent path", () => {
    const manifest = buildAgentSlackManifest(makeAgent(), "https://studio.example.com");
    const settings = manifest.settings as {
      event_subscriptions: { request_url: string; bot_events: string[] };
    };
    expect(settings.event_subscriptions.request_url).toBe(
      "https://studio.example.com/api/slack/events/bot-proj",
    );
    expect(settings.event_subscriptions.bot_events).toContain("app_mention");
  });

  it("enables MCP and points the redirect URL at the MCP OAuth callback", () => {
    const manifest = buildAgentSlackManifest(makeAgent(), "https://studio.example.com");
    const oauth = manifest.oauth_config as { redirect_urls: string[] };
    const settings = manifest.settings as { is_mcp_enabled: boolean };
    expect(oauth.redirect_urls).toEqual([
      "https://studio.example.com/api/mcps/oauth/callback",
    ]);
    expect(settings.is_mcp_enabled).toBe(true);
  });

  it("subscribes to the event that announces the agent container opening", () => {
    const manifest = buildAgentSlackManifest(makeAgent(), "https://studio.example.com");
    const settings = manifest.settings as {
      event_subscriptions: { bot_events: string[] };
    };

    // Without it the panel opens with no prompts and the app looks dead.
    expect(settings.event_subscriptions.bot_events).toContain("app_home_opened");
    // Acting on the channel a user is looking at needs storage that does not
    // exist, so subscribing would only buy traffic.
    expect(settings.event_subscriptions.bot_events).not.toContain("app_context_changed");
  });

  it("describes the agent from the agent and carries its prompts", () => {
    const prompts = [{ title: "Draw", message: "Draw me a cat" }];
    const manifest = buildAgentSlackManifest(
      makeAgent({
        description: "  Paints pictures on request.  ",
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
    expect(manifest.display_information).toMatchObject({
      description: "Paints pictures on request.",
    });
  });

  it("falls back to a generated description when the agent has none", () => {
    const manifest = buildAgentSlackManifest(
      makeAgent({ description: "   " }),
      "https://studio.example.com",
    );
    const features = manifest.features as { agent_view: { agent_description: string } };

    expect(features.agent_view.agent_description).toContain("bot-proj");
    expect(manifest.display_information).toMatchObject({
      description: features.agent_view.agent_description,
    });
  });

  it("truncates a description Slack would reject", () => {
    const manifest = buildAgentSlackManifest(
      makeAgent({ description: "x".repeat(400) }),
      "https://studio.example.com",
    );
    const features = manifest.features as { agent_view: { agent_description: string } };

    expect(features.agent_view.agent_description).toHaveLength(300);
    expect(manifest.display_information).toMatchObject({ description: "x".repeat(140) });
  });
});

describe("suggested prompts", () => {
  const repoFor = () => fakeRepo(makeAgent());

  it("drops the editor's blank rows instead of storing them", async () => {
    const { repo, current } = repoFor();

    await updateAgentSlack(
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
      updateAgentSlack(repo, "bot-proj", { suggestedPrompts: [{ title: "Draw", message: "" }] }, OWNER),
    ).rejects.toThrow("both a title and a message");
  });

  it("rejects more than Slack accepts", async () => {
    const { repo } = repoFor();
    const prompts = Array.from({ length: 5 }, (_, index) => ({
      title: `T${index}`,
      message: `M${index}`,
    }));

    await expect(
      updateAgentSlack(repo, "bot-proj", { suggestedPrompts: prompts }, OWNER),
    ).rejects.toThrow("at most 4");
  });

  it("leaves stored prompts alone when the update does not mention them", async () => {
    const { repo, current } = repoFor();
    await updateAgentSlack(
      repo,
      "bot-proj",
      { suggestedPrompts: [{ title: "Draw", message: "Draw me a cat" }] },
      OWNER,
    );

    await updateAgentSlack(repo, "bot-proj", { botToken: "xoxb-new" }, OWNER);

    expect(current().slack?.suggestedPrompts).toEqual([
      { title: "Draw", message: "Draw me a cat" },
    ]);
  });
});

describe("what the manifest asks Slack for", () => {
  const events = () => {
    const manifest = buildAgentSlackManifest(makeAgent(), "https://studio.example.com");
    return (manifest.settings as { event_subscriptions: { bot_events: string[] } })
      .event_subscriptions.bot_events;
  };
  const scopes = () => {
    const manifest = buildAgentSlackManifest(makeAgent(), "https://studio.example.com");
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
  const stored = (agent: Agent) => agent.slack?.channelKeywords;

  it("folds case and drops blanks and duplicates", async () => {
    const { repo, current } = fakeRepo(makeAgent());

    await updateAgentSlack(
      repo,
      "bot-proj",
      { channelKeywords: ["Deploy", "  ", "deploy", " 배포 "] },
      OWNER,
    );

    // Case is folded at rest because the list is shown back to the operator —
    // storing `Deploy` and `deploy` separately would display a distinction the
    // matcher does not make.
    expect(stored(current())).toEqual(["deploy", "배포"]);
    expect(current().slack?.keywordExecution).toEqual({ userId: "owner-user-id", revision: current().updatedAt });
  });

  it("refuses a keyword too short to be anything but noise", async () => {
    const { repo } = fakeRepo(makeAgent());

    await expect(
      updateAgentSlack(repo, "bot-proj", { channelKeywords: ["a"] }, OWNER),
    ).rejects.toThrow(/at least/);
  });

  it("refuses more than the cap", async () => {
    const { repo } = fakeRepo(makeAgent());
    const many = Array.from({ length: 21 }, (_, index) => `keyword${index}`);

    await expect(
      updateAgentSlack(repo, "bot-proj", { channelKeywords: many }, OWNER),
    ).rejects.toThrow(/At most/);
  });

  it("keeps what is stored when the update does not mention them", async () => {
    const { repo, current } = fakeRepo(makeAgent());
    await updateAgentSlack(repo, "bot-proj", { channelKeywords: ["deploy"] }, OWNER);
    const registration = current().slack?.keywordExecution;

    await updateAgentSlack(repo, "bot-proj", { enabled: false }, OWNER);

    expect(stored(current())).toEqual(["deploy"]);
    expect(current().slack?.keywordExecution).toEqual(registration);
  });

  it("clears them when the update sends an empty list", async () => {
    const { repo, current } = fakeRepo(makeAgent());
    await updateAgentSlack(repo, "bot-proj", { channelKeywords: ["deploy"] }, OWNER);

    await updateAgentSlack(repo, "bot-proj", { channelKeywords: [] }, OWNER);

    expect(stored(current())).toBeUndefined();
    expect(current().slack?.keywordExecution).toBeUndefined();
  });

  it("preserves unchanged registration and fences captured grants when keywords change", async () => {
    const { repo, current } = fakeRepo(makeAgent());
    await updateAgentSlack(repo, "bot-proj", { channelKeywords: ["[firing:"] }, OWNER);
    const registration = current().slack?.keywordExecution;
    await updateAgentSlack(repo, "bot-proj", { channelKeywords: [" [FIRING: "] }, OWNER);
    expect(current().slack?.keywordExecution).toEqual(registration);
    await updateAgentSlack(repo, "bot-proj", { channelKeywords: ["incident"] }, OWNER);
    expect(current().slack?.keywordExecution?.revision).not.toBe(registration?.revision);
  });

  it("requires the authenticated user's ID instead of inferring it from Agent ownership", async () => {
    const { repo } = fakeRepo(makeAgent());
    await expect(updateAgentSlackImpl(repo, "bot-proj", { channelKeywords: ["[firing:"] }, OWNER, secretCipher, ""))
      .rejects.toThrow("authenticated Studio user");
  });
});
