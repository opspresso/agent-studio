import { afterEach, describe, expect, it, vi } from "vitest";
import { slackClient } from "@/infrastructure/slack/client";
import { clearProfileCache } from "@/infrastructure/slack/profileCache";

/**
 * The transport, not the features. Two things had to be true of every Slack call
 * and were true of none: it has to end, and its failure has to name itself.
 *
 * Both matter more here than they look. A Slack run's work happens in `after()`,
 * past the response, so a hung call has nothing above it to give up — the run's
 * own deadline covers the model and the tools, not the reply. And Slack answers
 * a rate limit with 429 and a *non-JSON* body, which parsed as JSON turned
 * "slow down" into `Unexpected end of JSON input`.
 */

const TOKEN = "xoxb-test";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearProfileCache();
});

describe("how a Slack call fails", () => {
  it("names a rate limit as one, and quotes what Slack asked for", async () => {
    // The body is deliberately not JSON — that is what Slack sends, and reading
    // it first is what produced a parse error in place of a diagnosis.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("", { status: 429, headers: { "retry-after": "30" } }),
      ),
    );

    await expect(
      slackClient.channelHistory(TOKEN, { channel: "C1" }),
    ).rejects.toThrow(/rate limited; Slack asked for 30s/);
  });

  it("names the method and the status for any other transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 503 })));

    await expect(slackClient.listChannels(TOKEN)).rejects.toThrow(
      "Slack conversations.list failed: HTTP 503",
    );
  });

  it("still reports Slack's own error when the transport was fine", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "missing_scope" })));

    await expect(
      slackClient.messageReactions(TOKEN, { channel: "C1", ts: "1.0" }),
    ).rejects.toThrow("Slack reactions.get failed: missing_scope");
  });
});

describe("how long a Slack call may take", () => {
  it("bounds every request rather than waiting on Slack forever", async () => {
    // The signal is what the run has instead of a deadline: `after()` is past
    // the response, so nothing above this call will give up on its behalf.
    const seen: Array<AbortSignal | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        return jsonResponse({ ok: true, messages: [] });
      }),
    );

    await slackClient.threadReplies(TOKEN, { channel: "C1", ts: "1.0" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    // That the signal *fires* at its delay is Node's contract, not ours, and
    // `AbortSignal.timeout` is native so fake timers do not drive it — asserting
    // it would cost thirty seconds of suite time to re-verify the platform.
    // What this file owns is that no request goes out without one.
  });

});

describe("external file upload", () => {
  it.each([
    "http://files.slack.com/upload/v1/x",
    "https://127.0.0.1/upload/v1/x",
    "https://files.slack.com.evil.example/upload/v1/x",
    "https://files.slack.com/other/x",
    "https://user@files.slack.com/upload/v1/x",
  ])("refuses an unexpected upload target before sending bytes: %s", async (uploadUrl) => {
    const request = vi.fn(async () => jsonResponse({ ok: true, upload_url: uploadUrl, file_id: "F1" }));
    vi.stubGlobal("fetch", request);

    await expect(slackClient.uploadImage(TOKEN, {
      channel: "C1", filename: "generated.png", data: Buffer.from("image"),
    })).rejects.toThrow("Slack returned an unexpected file upload URL");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("posts bytes only to Slack's upload host without following redirects", async () => {
    const uploadUrl = "https://files.slack.com/upload/v1/abc";
    const request = vi.fn(async (url: string, _init?: RequestInit) =>
      url === uploadUrl
        ? new Response("", { status: 200 })
        : jsonResponse(url.includes("files.getUploadURLExternal")
          ? { ok: true, upload_url: uploadUrl, file_id: "F1" }
          : { ok: true }),
    );
    vi.stubGlobal("fetch", request);

    await slackClient.uploadImage(TOKEN, {
      channel: "C1", filename: "generated.png", data: Buffer.from("image"),
    });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[0]).toBe(uploadUrl);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
  });
});
