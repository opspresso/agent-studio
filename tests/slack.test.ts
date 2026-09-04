import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySlackSignature } from "@/infrastructure/slack/verify";
import { slackClient } from "@/infrastructure/slack/client";
import { BodyTooLargeError } from "@/shared/httpBody";
import { threadToTurns } from "@/application/slack/handleSlackEvent";

afterEach(() => {
  vi.unstubAllGlobals();
});

function sign(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  const secret = "test-secret";
  const body = '{"type":"url_verification"}';
  const now = 1_700_000_000;

  it("accepts a valid signature within the replay window", () => {
    const ts = String(now - 10);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        body,
        timestamp: ts,
        signature: sign(secret, ts, body),
        nowSeconds: now,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = String(now);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        body: body + "x",
        timestamp: ts,
        signature: sign(secret, ts, body),
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects stale timestamps (replay)", () => {
    const ts = String(now - 600);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        body,
        timestamp: ts,
        signature: sign(secret, ts, body),
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        body,
        timestamp: null,
        signature: null,
      }),
    ).toBe(false);
  });
});

describe("slackClient.threadReplies", () => {
  it("pages to the end of the thread so the newest replies are not dropped", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const second = url.includes("cursor=c2");
      return {
        ok: true,
        json: async () =>
          second
            ? { ok: true, messages: [{ ts: "3", text: "newest" }] }
            : {
                ok: true,
                messages: [
                  { ts: "1", text: "oldest" },
                  { ts: "2", text: "mid" },
                ],
                response_metadata: { next_cursor: "c2" },
              },
      };
    });

    const messages = await slackClient.threadReplies("tok", { channel: "C1", ts: "1" });

    expect(messages.map((m) => m.text)).toEqual(["oldest", "mid", "newest"]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("cursor=c2");
  });

  it("throws when Slack rejects the read", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ ok: false, error: "thread_not_found" }),
    }));

    await expect(slackClient.threadReplies("tok", { channel: "C1", ts: "1" })).rejects.toThrow(
      "thread_not_found",
    );
  });
});

describe("slackClient agent methods", () => {
  function captureCalls() {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, json: async () => ({ ok: true, ts: "200.1", channel: "D1" }) };
    });
    return calls;
  }

  it("opens, appends to and stops a stream on the chat.*Stream methods", async () => {
    const calls = captureCalls();

    const started = await slackClient.startStream("tok", { channel: "D1", thread_ts: "1.0" });
    await slackClient.appendStream("tok", { channel: "D1", ts: started.ts, markdown_text: "hi" });
    await slackClient.stopStream("tok", { channel: "D1", ts: started.ts });

    expect(calls.map((call) => call.url)).toEqual([
      "https://slack.com/api/chat.startStream",
      "https://slack.com/api/chat.appendStream",
      "https://slack.com/api/chat.stopStream",
    ]);
    expect(started.ts).toBe("200.1");
    expect(calls[1]?.body).toEqual({ channel: "D1", ts: "200.1", markdown_text: "hi" });
  });

  it("calls the assistant.threads.* methods with Slack's argument names", async () => {
    const calls = captureCalls();

    await slackClient.setStatus("tok", {
      channel_id: "D1",
      thread_ts: "1.0",
      status: "is thinking…",
    });
    await slackClient.setSuggestedPrompts("tok", {
      channel_id: "D1",
      prompts: [{ title: "Draw", message: "Draw me a cat" }],
    });
    await slackClient.setTitle("tok", { channel_id: "D1", thread_ts: "1.0", title: "Cats" });

    expect(calls.map((call) => call.url)).toEqual([
      "https://slack.com/api/assistant.threads.setStatus",
      "https://slack.com/api/assistant.threads.setSuggestedPrompts",
      "https://slack.com/api/assistant.threads.setTitle",
    ]);
    expect(calls[1]?.body).toEqual({
      channel_id: "D1",
      prompts: [{ title: "Draw", message: "Draw me a cat" }],
    });
  });

  it("resolves a user profile, preferring the display name", async () => {
    const { clearProfileCache } = await import("@/infrastructure/slack/profileCache");
    clearProfileCache();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          user: {
            name: "bruce",
            real_name: "Bruce Kim",
            tz: "Asia/Seoul",
            profile: { display_name: "bruce", image_512: "https://x/512.png" },
          },
        }),
      };
    });

    const profile = await slackClient.userProfile("tok-a", "U1");

    expect(urls[0]).toBe("https://slack.com/api/users.info?user=U1");
    expect(profile).toEqual({
      displayName: "bruce",
      timezone: "Asia/Seoul",
      avatarUrl: "https://x/512.png",
    });
  });

  it("falls past fields Slack returned as empty strings", async () => {
    const { clearProfileCache } = await import("@/infrastructure/slack/profileCache");
    clearProfileCache();
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        // Slack documents every field as possibly absent, null *or empty* —
        // `??` would keep the empty display_name and show a nameless caller.
        user: { name: "bruce", real_name: "Bruce Kim", tz: "", profile: { display_name: "" } },
      }),
    }));

    const profile = await slackClient.userProfile("tok-b", "U2");

    expect(profile).toEqual({ displayName: "Bruce Kim" });
  });

  it("resolves to null rather than throwing when Slack refuses", async () => {
    const { clearProfileCache } = await import("@/infrastructure/slack/profileCache");
    clearProfileCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ ok: false, error: "missing_scope" }),
    }));

    // A missing name must never be the reason a mention goes unanswered.
    await expect(slackClient.userProfile("tok-c", "U3")).resolves.toBeNull();
    vi.restoreAllMocks();
  });

  it("throws when Slack refuses a stream, so the caller can fall back", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ ok: false, error: "method_not_supported" }),
    }));

    await expect(
      slackClient.startStream("tok", { channel: "D1", thread_ts: "1.0" }),
    ).rejects.toThrow("method_not_supported");
  });
});

describe("slackClient.downloadFile", () => {
  const CAP = 1024;

  it("sends the bot token only to Slack file hosts", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, auth: init?.headers?.Authorization });
      return new Response("bytes");
    });

    const data = await slackClient.downloadFile(
      "tok",
      "https://files.slack.com/f/F1/shot.png",
      CAP,
    );

    expect(data.toString()).toBe("bytes");
    expect(seen[0]?.auth).toBe("Bearer tok");
  });

  /**
   * The caller's own pre-check reads Slack's declared `size`, which Slack is
   * free to omit — and this would answer `res.arrayBuffer()`, so a file with
   * no declared size was fully resident before anything measured it.
   */
  it("refuses a declared length over the cap without reading the body", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(new Uint8Array(CAP * 4), {
          headers: { "content-length": String(CAP * 4) },
        }),
    );

    const thrown = await slackClient
      .downloadFile("tok", "https://files.slack.com/f/F1/big.bin", CAP)
      .catch((error: unknown) => error);

    // `declaredBytes` is only set on the branch that refuses before reading, so
    // it is what tells the two halves of the rule apart.
    expect(thrown).toBeInstanceOf(BodyTooLargeError);
    expect((thrown as BodyTooLargeError).declaredBytes).toBe(CAP * 4);
  });

  it("cuts a body that never declared its length", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(CAP * 4)));

    await expect(
      slackClient.downloadFile("tok", "https://files.slack.com/f/F1/lying.bin", CAP),
    ).rejects.toThrow(/exceeds/);
  });

  it("refuses a foreign host without fetching it", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(new Uint8Array(0));
    });

    await expect(
      slackClient.downloadFile("tok", "https://evil.example.com/x", CAP),
    ).rejects.toThrow("unexpected host");
    expect(seen).toEqual([]);
  });

  it("does not send the bot token over HTTP even when the host matches", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(new Uint8Array(0));
    });

    await expect(
      slackClient.downloadFile("tok", "http://files.slack.com/f/F1/shot.png", CAP),
    ).rejects.toThrow("must use HTTPS");
    expect(seen).toEqual([]);
  });

  it("refuses a non-URL", async () => {
    await expect(slackClient.downloadFile("tok", "not a url", CAP)).rejects.toThrow("not a URL");
  });
});

describe("threadToTurns", () => {
  it("maps bot turns to assistant, humans to user, and drops the current event", () => {
    const turns = threadToTurns(
      [
        { ts: "1", user: "U1", text: "<@UBOT> first question" },
        { ts: "2", bot_id: "B1", text: "first answer" },
        { ts: "3", user: "U1", text: "" },
        { ts: "4", user: "U1", text: "follow-up" },
      ],
      "4",
    );
    expect(turns.map((t) => t.message)).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("claims only its own messages as assistant turns; another app's is a signed user turn", () => {
    // A channel is where several apps post into one thread. Reading `bot_id`
    // alone made a deploy notifier's output arrive as words this bot had said,
    // and it answered follow-ups as though it had said them. Told apart, the
    // notifier's message is what the person is asking about — kept, as theirs.
    const turns = threadToTurns(
      [
        { ts: "1", user: "U1", text: "did the deploy land?" },
        { ts: "2", bot_id: "B_CI", username: "CI", text: "Build 4f2c1 FAILED — 3 tests red" },
        { ts: "3", user: "UBOT", bot_id: "B_OURS", text: "checking now" },
        { ts: "4", user: "U1", text: "and now?" },
      ],
      "9",
      "UBOT",
    );

    expect(turns.map((t) => t.message)).toEqual([
      { role: "user", content: "did the deploy land?" },
      { role: "user", content: "Build 4f2c1 FAILED — 3 tests red" },
      { role: "assistant", content: "checking now" },
      { role: "user", content: "and now?" },
    ]);
    expect(turns.map((t) => t.appName)).toEqual([undefined, "CI", undefined, undefined]);
    expect(turns[1]?.userId).toBeUndefined();
  });

  it("reads an app's attachment as the turn's text, since that is where an alert lives", () => {
    const turns = threadToTurns(
      [
        {
          ts: "1",
          bot_id: "B_GRAFANA",
          bot_profile: { name: "Grafana" },
          text: "",
          attachments: [{ title: "[FIRING:1] OOMKilled", text: "sample-node was OOMKilled" }],
        },
        { ts: "2", user: "U1", text: "why?" },
      ],
      "9",
      "UBOT",
    );

    expect(turns.map((t) => t.message.content)).toEqual([
      "[FIRING:1] OOMKilled\nsample-node was OOMKilled",
      "why?",
    ]);
    expect(turns[0]?.appName).toBe("Grafana");
  });

  it("keeps the old rule when the envelope names no authorization", () => {
    // Nothing can tell our messages from another app's, and a thread whose own
    // replies vanished would be worse than one carrying a stranger's.
    const turns = threadToTurns(
      [
        { ts: "1", user: "U1", text: "question" },
        { ts: "2", bot_id: "B_OURS", text: "answer" },
      ],
      "9",
    );

    expect(turns.map((t) => t.message.role)).toEqual(["user", "assistant"]);
  });

  it("keeps a text-less turn that carried files, with its attachments", () => {
    const turns = threadToTurns(
      [
        { ts: "1", user: "U1", text: "", files: [{ id: "F1", mimetype: "image/png" }] },
        { ts: "2", user: "U1", text: "" },
      ],
      "9",
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.message).toEqual({ role: "user", content: "" });
    expect(turns[0]?.files).toEqual([{ id: "F1", mimetype: "image/png" }]);
  });
});
