/**
 * What a run is told about the person asking. Pure assembly, like the clock it
 * sits next to — the caller is an input here, never resolved in this file.
 */

import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "@/application/runtime";
import type { RunCaller } from "@/domain/execution/actor";

const NOW = new Date("2026-07-30T06:12:00Z");
const CLOCK_LINE =
  'Current date and time: 2026-07-30 (Thursday) 06:12 UTC. Resolve anything relative — "today", "yesterday", "last week", "this quarter" — from this line rather than from what you remember.';
const NO_IMAGES = { handles: [], canEdit: false, canTransfer: false };
/** A run with nothing bound, so only the blocks under test appear. */
const NO_BINDINGS = { skills: [], subagents: [], mcpServers: [], images: NO_IMAGES };

const CALLER: RunCaller = {
  displayName: "Bruce",
  timezone: "Asia/Seoul",
  avatarUrl: "https://avatars.slack-edge.com/bruce_512.png",
};

describe("the caller block in an agent prompt", () => {
  it("leaves the author's text byte-for-byte when nobody is named", () => {
    expect(buildAgentSystemPrompt({ base: "You are terse.", ...NO_BINDINGS })).toBe("You are terse.");
  });

  it("names the caller behind the engine-block boundary", () => {
    const prompt = buildAgentSystemPrompt({
      base: "You are terse.",
      ...NO_BINDINGS,
      caller: CALLER,
    });

    expect(prompt).toBe(
      "You are terse.\n\n---\n\nYou are answering Bruce." +
        " Their timezone is Asia/Seoul; resolve their relative times in it." +
        " Their avatar: https://avatars.slack-edge.com/bruce_512.png",
    );
  });

  it("says the avatar can be read when the run can read a URL", () => {
    // A URL nobody said was reachable is a URL nobody reaches. Asked to redraw
    // their own profile picture, a run with every capability on invented a face
    // instead: the address was in this block, FetchUrl was offered and returns
    // an image as an editable handle, and nothing connected the two.
    const prompt = buildAgentSystemPrompt({
      ...NO_BINDINGS,
      caller: CALLER,
      withUrlTool: true,
    });

    expect(prompt).toContain("read it with FetchUrl first");
    expect(prompt).toContain("Never draw a face from imagination");
  });

  it("stays quiet about reading it when the run cannot", () => {
    // Advice a run cannot take is worse than none — it spends prompt budget
    // pointing at a tool that was never offered.
    const prompt = buildAgentSystemPrompt({ ...NO_BINDINGS, caller: CALLER });

    expect(prompt).toContain("Their avatar: https://avatars.slack-edge.com/bruce_512.png");
    expect(prompt).not.toContain("FetchUrl");
  });

  it("carries only what the profile actually had", () => {
    const prompt = buildAgentSystemPrompt({
      ...NO_BINDINGS,
      caller: { displayName: "Bruce" },
    });

    expect(prompt).toBe("You are answering Bruce.");
  });

  it("sits with the clock ahead of the capability block, behind one boundary", () => {
    const prompt = buildAgentSystemPrompt({
      ...NO_BINDINGS,
      base: "You are terse.",
      skills: [{ name: "greeting", description: "How to greet" }],
      now: NOW,
      caller: CALLER,
    });

    // Both are facts about the run, not capabilities the framing speaks for.
    expect(prompt.indexOf(CLOCK_LINE)).toBeLessThan(prompt.indexOf("You are answering Bruce."));
    expect(prompt.indexOf("You are answering Bruce.")).toBeLessThan(
      prompt.indexOf("# Runtime capabilities"),
    );
    // One break for everything the engine appends, not one per block.
    expect(prompt.match(/^---$/gm)).toHaveLength(1);
  });
});
