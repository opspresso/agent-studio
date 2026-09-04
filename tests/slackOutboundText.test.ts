import { afterEach, describe, expect, it, vi } from "vitest";
import { neutralizeSlackMentions } from "@/domain/slack/outboundText";
import { slackClient } from "@/infrastructure/slack/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("outbound Slack mention safety", () => {
  it("neutralizes notifying tokens without changing ordinary mrkdwn", () => {
    expect(
      neutralizeSlackMentions(
        "*done* <!channel> <!here> <!everyone> <@U123ABC> <!subteam^S456|@ops> " +
          "<https://example.com|report> <!date^1750000000^{date_short}|today> <#C123>",
      ),
    ).toBe(
      "*done* &lt;!channel&gt; &lt;!here&gt; &lt;!everyone&gt; &lt;@U123ABC&gt; " +
        "&lt;!subteam^S456|@ops&gt; <https://example.com|report> " +
        "<!date^1750000000^{date_short}|today> <#C123>",
    );
  });

  it("sanitizes posts at the Slack wire boundary", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ok: true, ts: "1.0", channel: "C1" });
      }),
    );

    await slackClient.postMessage("token", {
      channel: "C1",
      text: "Review <!channel> with <@U123>",
    });

    expect(body).toMatchObject({
      channel: "C1",
      text: "Review &lt;!channel&gt; with &lt;@U123&gt;",
    });
  });

  it("sanitizes both text and task axes of a stream", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ok: true });
      }),
    );

    await slackClient.appendStream("token", {
      channel: "C1",
      ts: "1.0",
      chunks: [
        { type: "markdown_text", text: "<!here>" },
        {
          type: "task_update",
          id: "task-1",
          title: "Ask <@U123>",
          status: "in_progress",
          details: "Notify <!subteam^S456>",
        },
      ],
    });

    expect(body?.chunks).toEqual([
      { type: "markdown_text", text: "&lt;!here&gt;" },
      {
        type: "task_update",
        id: "task-1",
        title: "Ask &lt;@U123&gt;",
        status: "in_progress",
        details: "Notify &lt;!subteam^S456&gt;",
      },
    ]);
  });
});
