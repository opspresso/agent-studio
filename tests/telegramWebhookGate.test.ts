import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook decides which updates reach the handler at all, and what it
 * costs to refuse one: a wrong secret is a 401 and no work, an update nobody
 * addressed to the bot is a 200 and no claim. The handler is mocked; what is
 * under test is the routing.
 */
const { handled, claim, settle, failNext } = vi.hoisted(() => ({
  handled: [] as Array<{ kind: string; text?: string }>,
  claim: vi.fn(async () => true),
  settle: vi.fn(async () => {}),
  failNext: { value: false },
}));

vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/container", () => ({
  executionDeps: {},
  projectRepository: {},
  versionRepository: {},
  signArtifactUrl: undefined,
}));
vi.mock("@/infrastructure/telegram/client", () => ({ telegramClient: {} }));
vi.mock("@/infrastructure/llm/documentExtractor", () => ({ documentExtractor: {} }));
vi.mock("@/application/execution/runProject", () => ({ executeAgent: () => {} }));
vi.mock("@/infrastructure/db/repositories/telegramUpdateRepository", () => ({
  telegramUpdateRepository: {
    forBot: () => ({ updates: { claim, settle }, albums: { claim, settle } }),
  },
}));
vi.mock("@/infrastructure/db/repositories/transcriptRepository", () => ({
  transcriptRepository: {},
}));
vi.mock("@/application/telegram/handleUpdate", () => ({
  handleTelegramUpdate: async (
    _deps: unknown,
    disposition: { kind: string; text?: string },
  ) => {
    if (failNext.value) {
      failNext.value = false;
      throw new Error("boom");
    }
    handled.push({ kind: disposition.kind, ...(disposition.text !== undefined ? { text: disposition.text } : {}) });
  },
}));

const { handleTelegramUpdateRequest } = await import(
  "@/app/api/telegram/webhook/_lib/handleUpdateRequest"
);

const SECRET = "asg_test-secret";
const BINDING = { projectName: "painter", botToken: "42:tok", webhookSecret: SECRET, botUsername: "painter_bot" };

function request(payload: unknown, secret: string | null = SECRET): Request {
  return new Request("https://studio.example.com/api/telegram/webhook/painter", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }),
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

const privateMessage = (text: string, over: Record<string, unknown> = {}) => ({
  update_id: 10,
  message: {
    message_id: 7,
    date: 0,
    from: { id: 1, first_name: "Bruce" },
    chat: { id: 100, type: "private" },
    text,
    ...over,
  },
});

beforeEach(() => {
  handled.length = 0;
  claim.mockClear();
  settle.mockClear();
  claim.mockResolvedValue(true);
});

describe("the Telegram webhook", () => {
  it("refuses a delivery whose secret does not match, without touching the store", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrong = await handleTelegramUpdateRequest(request(privateMessage("hi"), "nope"), BINDING);
    const missing = await handleTelegramUpdateRequest(request(privateMessage("hi"), null), BINDING);

    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
    expect(handled).toEqual([]);
  });

  it("refuses a body that is not JSON", async () => {
    const res = await handleTelegramUpdateRequest(request("{not json"), BINDING);
    expect(res.status).toBe(400);
  });

  it("claims and handles a private message, keyed by the update id", async () => {
    const res = await handleTelegramUpdateRequest(request(privateMessage("hi")), BINDING);

    expect(res.status).toBe(200);
    expect(claim).toHaveBeenCalledWith("10", expect.any(Number), expect.any(Number));
    expect(handled).toEqual([{ kind: "run", text: "hi" }]);
    expect(settle).toHaveBeenCalledWith("10", "done");
  });

  it("acks a duplicate delivery without handling it again", async () => {
    claim.mockResolvedValueOnce(false);
    const res = await handleTelegramUpdateRequest(request(privateMessage("hi")), BINDING);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(handled).toEqual([]);
  });

  it("acks an update nobody addressed to the bot without claiming it", async () => {
    const res = await handleTelegramUpdateRequest(
      request(privateMessage("lunch?", { chat: { id: -1, type: "group" } })),
      BINDING,
    );

    expect(res.status).toBe(200);
    expect(claim).not.toHaveBeenCalled();
    expect(handled).toEqual([]);
  });

  it("acks what is not a message at all", async () => {
    const res = await handleTelegramUpdateRequest(request({ update_id: 11, edited_message: {} }), BINDING);
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });

  it("hands a command to the handler as a command", async () => {
    await handleTelegramUpdateRequest(
      request(privateMessage("/help", { entities: [{ type: "bot_command", offset: 0, length: 5 }] })),
      BINDING,
    );
    expect(handled).toEqual([{ kind: "command" }]);
  });

  it("settles a failed handling as failed so a redelivery can retry it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failNext.value = true;

    await handleTelegramUpdateRequest(request(privateMessage("hi")), BINDING);

    expect(settle).toHaveBeenCalledWith("10", "failed");
  });
});
