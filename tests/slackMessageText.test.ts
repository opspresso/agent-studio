/**
 * What a Slack message says, read once for the keyword match, the run's turn
 * and the thread history — `slackMessageText`. A person's message is its
 * `text`; an app's keeps the substance in attachments or blocks.
 */
import { describe, expect, it } from "vitest";
import { slackMessageText } from "@/domain/slack/messageText";

describe("slackMessageText", () => {
  it("is the text alone for an ordinary message", () => {
    expect(slackMessageText({ text: "how is the deploy going" })).toBe("how is the deploy going");
    expect(slackMessageText({})).toBe("");
  });

  it("reads an alert's attachment — pretext, title, body, fields — after the text", () => {
    expect(
      slackMessageText({
        text: "",
        attachments: [
          {
            pretext: "Alert",
            title: "[FIRING:1] Container OOMKilled",
            text: "container sample-node was OOMKilled",
            fields: [
              { title: "Severity", value: "warning" },
              { title: "", value: "eks-demo" },
              { title: "Empty", value: "  " },
            ],
          },
        ],
      }),
    ).toBe(
      "Alert\n[FIRING:1] Container OOMKilled\ncontainer sample-node was OOMKilled\nSeverity: warning\neks-demo",
    );
  });

  it("keeps a repeated part once, which folds a fallback and a text that mirrors the blocks", () => {
    expect(
      slackMessageText({
        text: "[FIRING:1] Container OOMKilled",
        attachments: [{ title: "[FIRING:1] Container OOMKilled", fallback: "[FIRING:1] Container OOMKilled" }],
      }),
    ).toBe("[FIRING:1] Container OOMKilled");
    expect(
      slackMessageText({
        text: "Build failed",
        blocks: [{ type: "section", text: { text: "Build failed" } }],
      }),
    ).toBe("Build failed");
  });

  it("reads the fallback only when an attachment has nothing else to read", () => {
    expect(slackMessageText({ attachments: [{ fallback: "one-line rendering" }] })).toBe(
      "one-line rendering",
    );
  });

  it("reads prose blocks by kind and skips the rest", () => {
    expect(
      slackMessageText({
        blocks: [
          { type: "header", text: { text: "Deploy report" } },
          { type: "section", text: { text: "3 services" }, fields: [{ text: "api: ok" }, { text: "web: ok" }] },
          { type: "divider" },
          { type: "image" },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: "by CI" },
              { type: "image", text: "ignored" },
              { type: "plain_text", text: "at 09:00" },
            ],
          },
          { type: "rich_text", elements: [{ type: "rich_text_section", text: "not read here" }] },
        ],
      }),
    ).toBe("Deploy report\n3 services\napi: ok\nweb: ok\nby CI at 09:00");
  });
});
