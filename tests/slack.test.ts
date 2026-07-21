import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "@/infrastructure/slack/verify";
import { parseMentionText, threadToMessages } from "@/application/slack/handleSlackEvent";

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

describe("parseMentionText", () => {
  it("strips the mention and detects a project selector", () => {
    expect(parseMentionText("<@U123ABC> project:support-triage classify this")).toEqual({
      projectName: "support-triage",
      message: "classify this",
    });
  });

  it("returns null project without a selector", () => {
    expect(parseMentionText("<@U123ABC> hello there")).toEqual({
      projectName: null,
      message: "hello there",
    });
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
