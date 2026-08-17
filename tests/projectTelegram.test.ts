import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  disconnectProjectTelegram,
  registerProjectTelegramWebhook,
  resolveProjectTelegramRuntime,
  resolveTelegramEventBinding,
  testProjectTelegram,
  updateProjectTelegram,
} from "@/application/telegram/projectTelegram";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { ForbiddenError, ValidationError } from "@/application/errors";
import type { Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";

const OWNER = "t@example.com";
const OTHER = "intruder@example.com";
const getMe = vi.fn(async (_token: string) => ({ id: 42, username: "painter_bot" }));

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
    const { view } = await updateProjectTelegram(
      repo,
      "bot-proj",
      { botToken: "42:AAHsecrettoken", enabled: true },
      OWNER,
      secretCipher,
      getMe,
    );

    expect(getMe).toHaveBeenCalledWith("42:AAHsecrettoken");
    expect(view.enabled).toBe(true);
    expect(view.configured).toBe(true);
    expect(view.botUsername).toBe("painter_bot");
    expect(view.botToken).not.toContain("secrettoken");
    expect(view.webhookPath).toBe("/api/telegram/webhook/bot-proj");
    const stored = current().telegram;
    expect(stored?.botToken.startsWith("enc:")).toBe(true);
    expect(stored?.webhookSecret.startsWith("enc:")).toBe(true);
    expect(secretCipher.decrypt(stored?.webhookSecret ?? "").startsWith("adg_")).toBe(true);
  });

  it("refuses a token Telegram does not accept, and stores nothing", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await expect(
      updateProjectTelegram(
        repo,
        "bot-proj",
        { botToken: "bad" },
        OWNER,
        secretCipher,
        async () => {
          throw new Error("Telegram getMe failed: Unauthorized");
        },
      ),
    ).rejects.toThrow(ValidationError);
    expect(current().telegram).toBeUndefined();
  });

  it("keeps the stored token and secret when the input is masked or empty", async () => {
    const { repo, current } = fakeRepo(makeProject());
    const checks = vi.fn(async (token: string) => ({ id: 42, username: `bot_${token}` }));
    await updateProjectTelegram(repo, "bot-proj", { botToken: "42:first" }, OWNER, secretCipher, checks);
    const first = current().telegram;
    const { view } = await updateProjectTelegram(
      repo,
      "bot-proj",
      { botToken: secretCipher.mask(first?.botToken ?? ""), enabled: true },
      OWNER,
      secretCipher,
      checks,
    );
    await updateProjectTelegram(repo, "bot-proj", { botToken: "" }, OWNER, secretCipher, checks);
    expect(view.enabled).toBe(true);
    expect(current().telegram?.botToken).toBe(first?.botToken);
    expect(current().telegram?.webhookSecret).toBe(first?.webhookSecret);
    // Only the first save reached Telegram: a mask can only confirm a secret.
    expect(checks.mock.calls).toEqual([["42:first"]]);
  });

  it("keeps the webhook secret across a token change", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await updateProjectTelegram(repo, "bot-proj", { botToken: "42:first" }, OWNER, secretCipher, getMe);
    const secret = current().telegram?.webhookSecret;
    await updateProjectTelegram(repo, "bot-proj", { botToken: "42:second" }, OWNER, secretCipher, getMe);
    expect(current().telegram?.webhookSecret).toBe(secret);
  });

  it("refuses to enable without a token, and refuses a non-agent project and a non-owner", async () => {
    const { repo } = fakeRepo(makeProject());
    await expect(
      updateProjectTelegram(repo, "bot-proj", { enabled: true }, OWNER, secretCipher, getMe),
    ).rejects.toThrow(ValidationError);
    const llm = fakeRepo(makeProject({ projectType: "llm" }));
    await expect(
      updateProjectTelegram(llm.repo, "bot-proj", { botToken: "42:x" }, OWNER, secretCipher, getMe),
    ).rejects.toThrow(ValidationError);
    await expect(
      updateProjectTelegram(repo, "bot-proj", { botToken: "42:x" }, OTHER, secretCipher, getMe),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("runtime, binding, test and webhook", () => {
  async function configured() {
    const { repo, current } = fakeRepo(makeProject());
    await updateProjectTelegram(repo, "bot-proj", { botToken: "42:tok", enabled: true }, OWNER, secretCipher, getMe);
    return { repo, current };
  }

  it("decrypts credentials only for an enabled bot", async () => {
    const { repo, current } = await configured();
    expect(resolveProjectTelegramRuntime(secretCipher, current())).toMatchObject({
      botToken: "42:tok",
      botUsername: "painter_bot",
    });
    await updateProjectTelegram(repo, "bot-proj", { enabled: false }, OWNER, secretCipher, getMe);
    expect(resolveProjectTelegramRuntime(secretCipher, current())).toBeNull();
    expect(await resolveTelegramEventBinding(repo, "bot-proj", secretCipher)).toBeNull();
  });

  it("binds an event to the project's decrypted secret and username", async () => {
    const { repo } = await configured();
    const binding = await resolveTelegramEventBinding(repo, "bot-proj", secretCipher);
    expect(binding).toMatchObject({ projectName: "bot-proj", botToken: "42:tok", botUsername: "painter_bot" });
    expect(binding?.webhookSecret.startsWith("adg_")).toBe(true);
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
