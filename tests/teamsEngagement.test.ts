import { describe, expect, it } from "vitest";
import { classifyTeamsActivity, stripBotMention } from "@/application/teams/engagement";
import type { TeamsActivity } from "@/application/teams/types";

function activity(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    id: "1",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    channelId: "msteams",
    from: { id: "29:user", name: "Bruce", aadObjectId: "aad-1" },
    conversation: { id: "a:1", conversationType: "personal" },
    recipient: { id: "28:bot", name: "Painter" },
    text: "hello",
    ...overrides,
  };
}

const runOf = (d: ReturnType<typeof classifyTeamsActivity>) =>
  d.kind === "run" ? { trigger: d.trigger, text: d.text } : d;

describe("classifyTeamsActivity", () => {
  it("answers every message in a personal chat", () => {
    expect(runOf(classifyTeamsActivity(activity()))).toEqual({ trigger: "personal", text: "hello" });
  });

  it("ignores what is not a message, and the bot's own", () => {
    expect(classifyTeamsActivity(activity({ type: "conversationUpdate" }))).toMatchObject({ kind: "ignore" });
    expect(classifyTeamsActivity(activity({ from: { id: "28:bot" } }))).toMatchObject({
      kind: "ignore",
      because: "from the bot itself",
    });
  });

  it("answers a channel message that mentions the bot, with the mention taken out and line breaks kept", () => {
    const text = "<at>Painter</at> fix this:\n\n```py\ndef f():\n    return 1\n```";
    const channel = activity({
      conversation: { id: "19:chan@thread.tacv2;messageid=5", conversationType: "channel" },
      text,
      entities: [{ type: "mention", mentioned: { id: "28:bot", name: "Painter" }, text: "<at>Painter</at>" }],
    });
    expect(runOf(classifyTeamsActivity(channel))).toEqual({
      trigger: "mention",
      text: "fix this:\n\n```py\ndef f():\n    return 1\n```",
    });
  });

  it("ignores a group message that mentions someone else, or nobody", () => {
    const other = activity({
      conversation: { id: "19:group@thread.v2", conversationType: "groupChat" },
      text: "<at>Ann</at> hi",
      entities: [{ type: "mention", mentioned: { id: "29:ann", name: "Ann" }, text: "<at>Ann</at>" }],
    });
    expect(classifyTeamsActivity(other)).toMatchObject({ kind: "ignore", because: "not addressed to the bot" });
    expect(
      classifyTeamsActivity(activity({ conversation: { id: "19:g", conversationType: "groupChat" } })),
    ).toMatchObject({ kind: "ignore" });
  });

  it("does not count the HTML twin of the text as an attachment, but does count a picture", () => {
    expect(
      classifyTeamsActivity(activity({ text: "", attachments: [{ contentType: "text/html", content: {} }] })),
    ).toMatchObject({ kind: "ignore", because: "nothing to read" });
    expect(
      runOf(classifyTeamsActivity(activity({ text: "", attachments: [{ contentType: "image/png", contentUrl: "https://smba.trafficmanager.net/emea/x" }] }))),
    ).toEqual({ trigger: "personal", text: "" });
  });

  it("refuses an activity with nowhere to answer", () => {
    expect(classifyTeamsActivity(activity({ serviceUrl: undefined }))).toMatchObject({ kind: "ignore" });
  });

  it("does not start an unattributed run for a message without a sender id", () => {
    expect(classifyTeamsActivity(activity({ from: undefined }))).toMatchObject({ kind: "ignore" });
    expect(classifyTeamsActivity(activity({ from: { id: "" } }))).toMatchObject({ kind: "ignore" });
    expect(runOf(classifyTeamsActivity(activity({ from: { id: "", aadObjectId: "aad-1" } }))))
      .toEqual({ trigger: "personal", text: "hello" });
  });
});

describe("stripBotMention", () => {
  it("removes only the entity's spelling of the mention, however many times", () => {
    const text = "<at>Painter</at> ping <at>Painter</at> pong <at>Bob</at>";
    const stripped = stripBotMention(
      activity({
        text,
        entities: [{ type: "mention", mentioned: { id: "28:bot" }, text: "<at>Painter</at>" }],
      }),
    );
    expect(stripped).toBe("ping pong <at>Bob</at>");
  });
});
