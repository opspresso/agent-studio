/**
 * What a run is told about the person asking. Pure assembly, like the clock it
 * sits next to — the caller is an input here, never resolved in this file.
 */

import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt, buildPromptMessages } from "@/application/llm/engine";
import type { RunCaller } from "@/domain/execution/actor";

const NOW = new Date("2026-07-30T06:12:00Z");
const CLOCK_LINE =
  'Current date and time: 2026-07-30 (Thursday) 06:12 UTC. Resolve anything relative — "today", "yesterday", "last week", "this quarter" — from this line rather than from what you remember.';
const NO_IMAGES = { handles: [], canEdit: false, canTransfer: false };

const CALLER: RunCaller = {
  displayName: "Bruce",
  timezone: "Asia/Seoul",
  avatarUrl: "https://avatars.slack-edge.com/bruce_512.png",
};

describe("the caller block in an agent prompt", () => {
  it("leaves the author's text byte-for-byte when nobody is named", () => {
    expect(buildAgentSystemPrompt("You are terse.", [], [], [], NO_IMAGES)).toBe("You are terse.");
  });

  it("names the caller behind the engine-block boundary", () => {
    const prompt = buildAgentSystemPrompt(
      "You are terse.",
      [],
      [],
      [],
      NO_IMAGES,
      undefined,
      false,
      CALLER,
    );

    expect(prompt).toBe(
      "You are terse.\n\n---\n\nYou are answering Bruce." +
        " Their timezone is Asia/Seoul; resolve their relative times in it." +
        " Their avatar: https://avatars.slack-edge.com/bruce_512.png",
    );
  });

  it("carries only what the profile actually had", () => {
    const prompt = buildAgentSystemPrompt(
      undefined,
      [],
      [],
      [],
      NO_IMAGES,
      undefined,
      false,
      { displayName: "Bruce" },
    );

    expect(prompt).toBe("You are answering Bruce.");
  });

  it("sits with the clock ahead of the capability block, behind one boundary", () => {
    const prompt = buildAgentSystemPrompt(
      "You are terse.",
      [{ name: "greeting", description: "How to greet" }],
      [],
      [],
      NO_IMAGES,
      NOW,
      false,
      CALLER,
    );

    // Both are facts about the run, not capabilities the framing speaks for.
    expect(prompt.indexOf(CLOCK_LINE)).toBeLessThan(prompt.indexOf("You are answering Bruce."));
    expect(prompt.indexOf("You are answering Bruce.")).toBeLessThan(
      prompt.indexOf("# Runtime capabilities"),
    );
    // One break for everything the engine appends, not one per block.
    expect(prompt.match(/^---$/gm)).toHaveLength(1);
  });
});

describe("the caller block in a single-shot prompt", () => {
  const base = { model: "openai/gpt-5.4", userPromptTemplate: "Summarize this." };

  it("uses the same boundary the agent prompt does", () => {
    const messages = buildPromptMessages({
      ...base,
      systemPrompt: "You summarize.",
      caller: { displayName: "Bruce" },
    });

    expect(messages[0]).toEqual({
      role: "system",
      content: "You summarize.\n\n---\n\nYou are answering Bruce.",
    });
  });

  it("sends no system message with neither a prompt, a clock nor a caller", () => {
    expect(buildPromptMessages(base).some((message) => message.role === "system")).toBe(false);
  });
});
