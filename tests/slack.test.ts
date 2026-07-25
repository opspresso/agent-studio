import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySlackSignature } from "@/infrastructure/slack/verify";
import { slackClient } from "@/infrastructure/slack/client";
import { threadToMessages } from "@/application/slack/handleSlackEvent";

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

describe("slackClient.downloadFile", () => {
  it("sends the bot token only to Slack file hosts", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, auth: init?.headers?.Authorization });
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer };
    });

    const data = await slackClient.downloadFile("tok", "https://files.slack.com/f/F1/shot.png");

    expect(data.toString()).toBe("bytes");
    expect(seen[0]?.auth).toBe("Bearer tok");
  });

  it("refuses a foreign host without fetching it", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    });

    await expect(slackClient.downloadFile("tok", "https://evil.example.com/x")).rejects.toThrow(
      "unexpected host",
    );
    expect(seen).toEqual([]);
  });

  it("refuses a non-URL", async () => {
    await expect(slackClient.downloadFile("tok", "not a url")).rejects.toThrow("not a URL");
  });
});

describe("threadToMessages", () => {
  it("maps bot turns to assistant, humans to user, and drops the current event", () => {
    const messages = threadToMessages(
      [
        { ts: "1", user: "U1", text: "<@UBOT> first question" },
        { ts: "2", bot_id: "B1", text: "first answer" },
        { ts: "3", user: "U1", text: "" },
        { ts: "4", user: "U1", text: "follow-up" },
      ],
      "4",
    );
    expect(messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });
});
