/**
 * The clock a run stamps its prompt with. Pure assembly only — the instant is an
 * input here, exactly as the engine receives it, so nothing in this file reads
 * the real clock.
 */

import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "@/application/runtime";

const NOW = new Date("2026-07-30T06:12:00Z");
const CLOCK_LINE =
  'Current date and time: 2026-07-30 (Thursday) 06:12 UTC. Resolve anything relative — "today", "yesterday", "last week", "this quarter" — from this line rather than from what you remember.';
/** A run that can neither edit nor hand over an image, so no image section. */
const NO_IMAGES = { handles: [], canEdit: false, canTransfer: false };
/** A run with nothing bound, so only the blocks under test appear. */
const NO_BINDINGS = { skills: [], subagents: [], mcpServers: [], images: NO_IMAGES };

describe("agent prompt clock", () => {
  it("leaves the author's text byte-for-byte when no clock is injected", () => {
    expect(buildAgentSystemPrompt({ base: "You are terse.", ...NO_BINDINGS })).toBe("You are terse.");
  });

  it("appends the clock behind the engine-block boundary", () => {
    expect(buildAgentSystemPrompt({ base: "You are terse.", ...NO_BINDINGS, now: NOW })).toBe(
      `You are terse.\n\n---\n\n${CLOCK_LINE}`,
    );
  });

  it("carries the clock when the Agent has no prompt of its own", () => {
    expect(buildAgentSystemPrompt({ ...NO_BINDINGS, now: NOW })).toBe(CLOCK_LINE);
  });

  it("puts the clock ahead of the capability block, behind a single boundary", () => {
    const prompt = buildAgentSystemPrompt({
      ...NO_BINDINGS,
      base: "You are terse.",
      skills: [{ name: "greeting", description: "How to greet" }],
      now: NOW,
    });
    // The framing speaks for the sections that follow it, and the clock is not
    // one of them — it is a fact about when the run happens.
    expect(prompt).toContain(CLOCK_LINE);
    expect(prompt.indexOf(CLOCK_LINE)).toBeLessThan(prompt.indexOf("# Runtime capabilities"));
    expect(prompt).toContain("## Available Skills");
    // One break for everything the engine appends, not one per block.
    expect(prompt.match(/^---$/gm)).toHaveLength(1);
  });
});
