import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramClient } from "@/infrastructure/telegram/client";

/**
 * The transport, not the features: every call has to end, its failure has to
 * name itself, and nothing it says may carry the token — which sits in every
 * URL the Bot API is reached at.
 */

const TOKEN = "42:AAHtoken";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return handler(url, init);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("how a Telegram call fails", () => {
  it.each([{}, { message_id: "9" }, { message_id: -1 }, { message_id: 1.5 }])("rejects an invalid message receipt: %j", async (result) => {
    const calls = stubFetch(() => jsonResponse({ ok: true, result }));
    await expect(telegramClient.sendMessage(TOKEN, { chatId: 1, text: "reply" }))
      .rejects.toThrow("Telegram sendMessage returned an invalid result");
    expect(calls).toHaveLength(1);
  });

  it.each([{}, { id: "42" }, { id: 42, username: 9 }])("rejects invalid bot identities: %j", async (result) => {
    stubFetch(() => jsonResponse({ ok: true, result }));
    await expect(telegramClient.getMe(TOKEN)).rejects.toThrow("Telegram getMe returned an invalid result");
  });

  it.each([null, { ok: "true", result: true }, { ok: false, description: { token: TOKEN } }])("rejects malformed response envelopes without exposing their body: %j", async (body) => {
    stubFetch(() => jsonResponse(body));
    await expect(telegramClient.deleteWebhook(TOKEN)).rejects.toThrow("Telegram deleteWebhook returned an invalid response");
  });

  it("does not report webhook registration as successful without the API confirmation", async () => {
    stubFetch(() => jsonResponse({ ok: true, result: false }));
    await expect(telegramClient.setWebhook(TOKEN, { url: "https://studio/webhook", secretToken: "secret", allowedUpdates: ["message"] }))
      .rejects.toThrow("Telegram setWebhook returned an invalid result");
  });

  it("refuses an invalid file path before attempting a download", async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true, result: { file_path: { path: "photos/1.jpg" } } }));
    await expect(telegramClient.downloadFile(TOKEN, "f1", 10)).rejects.toThrow("Telegram getFile returned an invalid result");
    expect(calls).toHaveLength(1);
  });

  it("names a rate limit as one, and quotes what Telegram asked for", async () => {
    stubFetch(() =>
      jsonResponse(
        { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } },
        { status: 429 },
      ),
    );
    await expect(telegramClient.sendChatAction(TOKEN, { chatId: 1, action: "typing" })).rejects.toThrow(
      /Telegram sendChatAction rate limited; Telegram asked for 7s/,
    );
  });

  it("names the method and Telegram's own description", async () => {
    stubFetch(() =>
      jsonResponse({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, { status: 400 }),
    );
    await expect(
      telegramClient.editMessageText(TOKEN, { chatId: 1, messageId: 2, text: "x" }),
    ).rejects.toThrow("Telegram editMessageText failed: Bad Request: message is not modified");
  });

  it("names the status when the body is not JSON, and never the token", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 502 }));
    const failure = await telegramClient.getMe(TOKEN).catch((error: Error) => error.message);
    expect(failure).toBe("Telegram getMe failed: HTTP 502");
    expect(failure).not.toContain("AAHtoken");
  });

  it("does not carry the token from a failed transport or Bot API description", async () => {
    stubFetch((url) => {
      throw new Error(`request failed for ${url}`);
    });
    const transportFailure = await telegramClient.getMe(TOKEN).catch((error: Error) => error.message);
    expect(transportFailure).toContain("Telegram getMe");
    expect(transportFailure).not.toContain(TOKEN);

    stubFetch(() => jsonResponse({
      ok: false,
      description: `Bad Request for bot ${TOKEN}`,
    }, { status: 400 }));
    const apiFailure = await telegramClient.getMe(TOKEN).catch((error: Error) => error.message);
    expect(apiFailure).toContain("Bad Request");
    expect(apiFailure).not.toContain(TOKEN);
  });
});

describe("what a Telegram call sends", () => {
  it("preserves a scheduled message's zero ID instead of treating it as malformed", async () => {
    stubFetch(() => jsonResponse({ ok: true, result: { message_id: 0 } }));
    await expect(telegramClient.sendMessage(TOKEN, { chatId: 1, text: "reply" })).resolves.toEqual({ messageId: 0 });
  });

  it("reads a bot identity and ignores unrelated API fields", async () => {
    stubFetch(() => jsonResponse({ ok: true, result: { id: 42, is_bot: true, username: "my_bot", first_name: "Bot" } }));
    await expect(telegramClient.getMe(TOKEN)).resolves.toEqual({ id: 42, username: "my_bot", firstName: "Bot" });
  });

  it("posts JSON to the method under the token, and reads the result", async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true, result: { message_id: 9 } }));
    const sent = await telegramClient.sendMessage(TOKEN, {
      chatId: 100,
      text: "hi",
      threadId: 5,
      replyToMessageId: 7,
      parseMode: "HTML",
    });
    expect(sent).toEqual({ messageId: 9 });
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      chat_id: 100,
      text: "hi",
      message_thread_id: 5,
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
      parse_mode: "HTML",
    });
  });

  it("registers a webhook with the secret and the update kinds it wants", async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true, result: true }));
    await telegramClient.setWebhook(TOKEN, {
      url: "https://studio/api/telegram/webhook/p",
      secretToken: "asg_x",
      allowedUpdates: ["message"],
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      url: "https://studio/api/telegram/webhook/p",
      secret_token: "asg_x",
      allowed_updates: ["message"],
    });
  });

  it("downloads a file in two steps, bounded while it is read", async () => {
    const calls = stubFetch((url) =>
      url.endsWith("/getFile")
        ? jsonResponse({ ok: true, result: { file_path: "photos/1.jpg", file_size: 3 } })
        : new Response("abc", { status: 200 }),
    );
    const bytes = await telegramClient.downloadFile(TOKEN, "f1", 10);
    expect(bytes.toString()).toBe("abc");
    expect(calls[1]?.url).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/1.jpg`);
  });

  it("refuses a file Telegram declares larger than the cap before fetching it", async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true, result: { file_path: "p", file_size: 99 } }));
    await expect(telegramClient.downloadFile(TOKEN, "f1", 10)).rejects.toThrow(/larger than the 10 byte cap/);
    expect(calls).toHaveLength(1);
  });

  it("uploads a photo as multipart form data", async () => {
    const calls = stubFetch(() => jsonResponse({ ok: true, result: {} }));
    await telegramClient.sendPhoto(TOKEN, {
      chatId: 100,
      photo: Buffer.from("png"),
      filename: "a.png",
      caption: "cat",
    });
    const body = calls[0]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("chat_id")).toBe("100");
    expect(form.get("caption")).toBe("cat");
    expect((form.get("photo") as File).name).toBe("a.png");
  });
});
