import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  disconnectProjectTelegram,
  listProjectTelegramDestinations,
  registerProjectTelegramWebhook,
  resolveProjectTelegramRuntime,
  resolveTelegramEventBinding,
  revokeProjectTelegramWebhook,
  testProjectTelegram,
  updateProjectTelegram,
} from "@/application/telegram/projectTelegram";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { ForbiddenError, ValidationError } from "@/application/errors";
import type { Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { TelegramDestinationRepository } from "@/domain/telegram/destination";

const OWNER = "t@example.com";
const OTHER = "intruder@example.com";
const BASE_URL = "https://studio.example.com";
const getMe = vi.fn(async (_token: string) => ({ id: 42, username: "painter_bot" }));

/** The Bot API calls the slice makes, recorded. */
function makeCalls(overrides: Partial<Parameters<typeof updateProjectTelegram>[5]> = {}) {
  const registered: Array<{ token: string; url: string; secretToken: string }> = [];
  const deleted: string[] = [];
  const calls: Parameters<typeof updateProjectTelegram>[5] = {
    getMe,
    setWebhook: async (token, args) => {
      registered.push({ token, url: args.url, secretToken: args.secretToken });
    },
    deleteWebhook: async (token) => {
      deleted.push(token);
    },
    ...overrides,
  };
  return { calls, registered, deleted };
}

/** `updateProjectTelegram` with the recorded calls and the base URL filled in. */
function update(
  repo: ProjectRepository,
  input: Parameters<typeof updateProjectTelegram>[2],
  email: string,
  calls = makeCalls().calls,
) {
  return updateProjectTelegram(repo, "bot-proj", input, email, secretCipher, calls, BASE_URL);
}

beforeAll(() => {
  process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: "bot-proj",
    displayName: "Bot Project",
    description: "",
    projectType: "agent",
    ownerEmail: OWNER,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fakeRepo(initial: Project): { repo: ProjectRepository; current: () => Project } {
  let stored = initial;
  const repo = {
    async get(name: string) {
      return name === stored.name ? stored : null;
    },
    async list() {
      return [stored];
    },
    async create(p: Project) {
      stored = p;
    },
    async update(p: Project) {
      stored = p;
    },
    async publish(p: Project) {
      stored = p;
    },
    async delete() {},
    async getApiToken() {
      return null;
    },
    async setApiToken() {},
    async deleteApiToken() {},
  } as unknown as ProjectRepository;
  return { repo, current: () => stored };
}

describe("updateProjectTelegram", () => {
  it("checks a new token with Telegram, encrypts it, mints the webhook secret and masks the response", async () => {
    const { repo, current } = fakeRepo(makeProject());
    const { calls, registered } = makeCalls();
    const { view } = await update(repo, { botToken: "42:AAHsecrettoken", enabled: true }, OWNER, calls);

    expect(getMe).toHaveBeenCalledWith("42:AAHsecrettoken");
    // Enabled with a token: registered at this deployment, with the minted secret.
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ token: "42:AAHsecrettoken", url: `${BASE_URL}/api/telegram/webhook/bot-proj` });
    expect(registered[0]?.secretToken.startsWith("asg_")).toBe(true);
    expect(view.enabled).toBe(true);
    expect(view.configured).toBe(true);
    expect(view.botUsername).toBe("painter_bot");
    expect(view.botToken).not.toContain("secrettoken");
    expect(view.webhookPath).toBe("/api/telegram/webhook/bot-proj");
    const stored = current().telegram;
    expect(stored?.botToken.startsWith("enc:")).toBe(true);
    expect(stored?.webhookSecret.startsWith("enc:")).toBe(true);
    expect(secretCipher.decrypt(stored?.webhookSecret ?? "").startsWith("asg_")).toBe(true);
  });

  it("refuses a token Telegram does not accept, and stores nothing", async () => {
    const { repo, current } = fakeRepo(makeProject());
    const { calls } = makeCalls({
      getMe: async () => {
        throw new Error("Telegram getMe failed: Unauthorized");
      },
    });
    await expect(update(repo, { botToken: "bad" }, OWNER, calls)).rejects.toThrow(ValidationError);
    expect(current().telegram).toBeUndefined();
  });

  it("keeps the stored token and secret when the input is masked or empty", async () => {
    const { repo, current } = fakeRepo(makeProject());
    const checks = vi.fn(async (token: string) => ({ id: 42, username: `bot_${token}` }));
    const { calls } = makeCalls({ getMe: checks });
    await update(repo, { botToken: "42:first" }, OWNER, calls);
    const first = current().telegram;
    const { view } = await update(
      repo,
      { botToken: secretCipher.mask(first?.botToken ?? ""), enabled: true },
      OWNER,
      calls,
    );
    await update(repo, { botToken: "" }, OWNER, calls);
    expect(view.enabled).toBe(true);
    expect(current().telegram?.botToken).toBe(first?.botToken);
    expect(current().telegram?.webhookSecret).toBe(first?.webhookSecret);
    // Only the first save reached Telegram: a mask can only confirm a secret.
    expect(checks.mock.calls).toEqual([["42:first"]]);
  });

  it("retires the old bot and re-keys the secret when the token changes, registering the new one when enabled", async () => {
    const { repo, current } = fakeRepo(makeProject());
    const { calls, registered, deleted } = makeCalls();
    await update(repo, { botToken: "42:first", enabled: true }, OWNER, calls);
    const secret = current().telegram?.webhookSecret;
    await update(repo, { botToken: "43:second" }, OWNER, calls);
    expect(deleted).toEqual(["42:first"]);
    expect(current().telegram?.webhookSecret).not.toBe(secret);
    expect(registered.map((r) => r.token)).toEqual(["42:first", "43:second"]);
    // The same token again is not a change.
    await update(repo, { botToken: "43:second" }, OWNER, calls);
    expect(deleted).toEqual(["42:first"]);
    expect(registered).toHaveLength(2);
  });

  it("registers the webhook when the bot is enabled and deletes it when disabled", async () => {
    const { repo } = fakeRepo(makeProject());
    const { calls, registered, deleted } = makeCalls();
    await update(repo, { botToken: "42:tok" }, OWNER, calls);
    expect(registered).toEqual([]);
    await update(repo, { enabled: true }, OWNER, calls);
    expect(registered).toHaveLength(1);
    await update(repo, { enabled: false }, OWNER, calls);
    expect(deleted).toEqual(["42:tok"]);
    // Off stays off without another call.
    await update(repo, { enabled: false }, OWNER, calls);
    expect(deleted).toHaveLength(1);
  });

  it("stores the credentials and says so when Telegram refuses the webhook", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { repo, current } = fakeRepo(makeProject());
    const { calls } = makeCalls({
      setWebhook: async () => {
        throw new Error("Telegram setWebhook failed: Bad Request: bad webhook: HTTPS url must be provided");
      },
    });
    const result = await update(repo, { botToken: "42:tok", enabled: true }, OWNER, calls);
    expect(current().telegram?.enabled).toBe(true);
    expect(result.warnings?.[0]).toContain("Telegram did not accept the webhook");
  });

  it("refuses to enable without a token, and refuses a non-agent project and a non-owner", async () => {
    const { repo } = fakeRepo(makeProject());
    await expect(update(repo, { enabled: true }, OWNER)).rejects.toThrow(ValidationError);
    const llm = fakeRepo(makeProject({ projectType: "llm" }));
    await expect(update(llm.repo, { botToken: "42:x" }, OWNER)).rejects.toThrow(ValidationError);
    await expect(update(repo, { botToken: "42:x" }, OTHER)).rejects.toThrow(ForbiddenError);
  });
});

describe("runtime, binding, test and webhook", () => {
  async function configured() {
    const { repo, current } = fakeRepo(makeProject());
    await update(repo, { botToken: "42:tok", enabled: true }, OWNER);
    return { repo, current };
  }

  it("decrypts credentials only for an enabled bot", async () => {
    const { repo, current } = await configured();
    expect(resolveProjectTelegramRuntime(secretCipher, current())).toMatchObject({
      botToken: "42:tok",
      botUsername: "painter_bot",
    });
    await update(repo, { enabled: false }, OWNER);
    expect(resolveProjectTelegramRuntime(secretCipher, current())).toBeNull();
    expect(await resolveTelegramEventBinding(repo, "bot-proj", secretCipher)).toBeNull();
  });

  it("binds an event to the project's decrypted secret and username", async () => {
    const { repo } = await configured();
    const binding = await resolveTelegramEventBinding(repo, "bot-proj", secretCipher);
    expect(binding).toMatchObject({ projectName: "bot-proj", botToken: "42:tok", botUsername: "painter_bot" });
    expect(binding?.webhookSecret.startsWith("asg_")).toBe(true);
  });

  it("lists only the current bot's observed destinations for an owner", async () => {
    const { repo } = await configured();
    const list = vi.fn(async () => [
      {
        chatId: 100,
        chatType: "private" as const,
        title: "Bruce",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const destinations = { list, put: async () => {} } satisfies TelegramDestinationRepository;

    await expect(
      listProjectTelegramDestinations(repo, destinations, "bot-proj", OWNER, secretCipher),
    ).resolves.toHaveLength(1);
    expect(list).toHaveBeenCalledWith("bot-proj", 42);
    await expect(
      listProjectTelegramDestinations(repo, destinations, "bot-proj", OTHER, secretCipher),
    ).rejects.toThrow(ForbiddenError);
  });

  it("tests the stored token and reports who the bot is", async () => {
    const { repo } = await configured();
    expect(await testProjectTelegram(repo, "bot-proj", OWNER, secretCipher, getMe)).toEqual({
      ok: true,
      botId: 42,
      botUsername: "painter_bot",
    });
    const bare = fakeRepo(makeProject());
    expect(await testProjectTelegram(bare.repo, "bot-proj", OWNER, secretCipher, getMe)).toEqual({ ok: false });
  });

  it("registers the webhook at this deployment's URL with the minted secret", async () => {
    const { repo, current } = await configured();
    const calls: Array<{ token: string; url: string; secretToken: string; allowedUpdates: readonly string[] }> = [];
    const result = await registerProjectTelegramWebhook(
      repo,
      "bot-proj",
      OWNER,
      secretCipher,
      "https://studio.example.com",
      async (token, args) => {
        calls.push({ token, ...args });
      },
    );
    expect(result).toEqual({ ok: true, url: "https://studio.example.com/api/telegram/webhook/bot-proj" });
    expect(calls[0]).toMatchObject({
      token: "42:tok",
      secretToken: secretCipher.decrypt(current().telegram?.webhookSecret ?? ""),
      allowedUpdates: ["message"],
    });
  });

  it("disconnects, telling Telegram first and dropping the credentials even when that fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { repo, current } = await configured();
    const deleted: string[] = [];
    await disconnectProjectTelegram(repo, "bot-proj", OWNER, secretCipher, async (token) => {
      deleted.push(token);
      throw new Error("Telegram deleteWebhook failed: HTTP 500");
    });
    expect(deleted).toEqual(["42:tok"]);
    expect(current().telegram).toBeUndefined();
  });
});

describe("revokeProjectTelegramWebhook", () => {
  it("tells Telegram to drop an enabled bot's webhook, and nothing for a disabled or absent one", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await update(repo, { botToken: "42:tok", enabled: true }, OWNER);
    const deleted: string[] = [];
    await revokeProjectTelegramWebhook(secretCipher, current(), async (token) => {
      deleted.push(token);
    });
    expect(deleted).toEqual(["42:tok"]);
    await update(repo, { enabled: false }, OWNER);
    await revokeProjectTelegramWebhook(secretCipher, current(), async (token) => {
      deleted.push(token);
    });
    await revokeProjectTelegramWebhook(secretCipher, makeProject(), async (token) => {
      deleted.push(token);
    });
    expect(deleted).toEqual(["42:tok"]);
  });
});
