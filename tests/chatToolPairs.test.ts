import { describe, expect, it } from "vitest";
import { pairToolTraffic, storedToolArgs } from "@/app/chats/_lib/toolPairs";
import { describeTool, parseWireToolCall } from "@/app/_lib/toolCalls";
import type { ChatMessage } from "@/domain/chat/types";

function wireCall(id: string, name: string, args: string): unknown {
  return { id, type: "function", function: { name, arguments: args } };
}

describe("pairToolTraffic", () => {
  it("puts a call and its result in one row", () => {
    expect(
      pairToolTraffic([{ name: "search", args: "{}" }], [{ name: "search", content: "hits" }]),
    ).toEqual([{ name: "search", args: "{}", content: "hits" }]);
  });

  it("leaves a call that has not answered yet without content", () => {
    expect(pairToolTraffic([{ name: "search", args: "{}" }], [])).toEqual([
      { name: "search", args: "{}" },
    ]);
  });

  /**
   * The case two flat lists cannot express: the same tool twice, where "which
   * result belongs to which call" is the only question the reader has.
   */
  it("gives the same tool's second result to its second call", () => {
    expect(
      pairToolTraffic(
        [
          { name: "search", args: "{a}" },
          { name: "search", args: "{b}" },
        ],
        [
          { name: "search", content: "first" },
          { name: "search", content: "second" },
        ],
      ),
    ).toEqual([
      { name: "search", args: "{a}", content: "first" },
      { name: "search", args: "{b}", content: "second" },
    ]);
  });

  it("does not let one tool's result answer another tool's call", () => {
    expect(
      pairToolTraffic(
        [
          { name: "search", args: "{a}" },
          { name: "fetch", args: "{b}" },
        ],
        [{ name: "fetch", content: "page" }],
      ),
    ).toEqual([
      { name: "search", args: "{a}" },
      { name: "fetch", args: "{b}", content: "page" },
    ]);
  });

  /**
   * A subagent's result reaches the live turn without the call that declared it
   * — the call belongs to the child's conversation. Keeping it says what ran.
   */
  it("keeps a result that matches no call rather than dropping it", () => {
    expect(pairToolTraffic([], [{ name: "Skill", content: "loaded" }])).toEqual([
      { name: "Skill", content: "loaded" },
    ]);
  });

  it("keeps calls in the order they were made", () => {
    const pairs = pairToolTraffic(
      [
        { name: "a", args: "1" },
        { name: "b", args: "2" },
        { name: "c", args: "3" },
      ],
      [{ name: "c", content: "third" }],
    );
    expect(pairs.map((pair) => pair.name)).toEqual(["a", "b", "c"]);
    expect(pairs[2]?.content).toBe("third");
  });

  /**
   * The exact pairing, and the one two flat lists could never do: the id is what
   * the engine itself matches on.
   */
  it("prefers the call id over the name", () => {
    expect(
      pairToolTraffic(
        [
          { id: "c1", name: "search", args: "{a}" },
          { id: "c2", name: "search", args: "{b}" },
        ],
        [
          { id: "c2", name: "search", content: "second" },
          { id: "c1", name: "search", content: "first" },
        ],
      ),
    ).toEqual([
      { id: undefined, name: "search", args: "{a}", content: "first" },
      { id: undefined, name: "search", args: "{b}", content: "second" },
    ]);
  });

  /**
   * The regression that made this pairing worth testing. A call used to be
   * decorated for display — `Skill: deep-research` — while its result carries the
   * plain `Skill`, so matching by name split every skill call back into the two
   * rows the pairing exists to join.
   */
  it("matches a Skill call to its result, which carries the undecorated name", () => {
    const call = parseWireToolCall(
      wireCall("call_1", "Skill", JSON.stringify({ skill_name: "deep-research" })),
    );
    expect(call.name).toBe("Skill");

    const pairs = pairToolTraffic([call], [{ name: "Skill", content: "loaded" }]);
    expect(pairs).toHaveLength(1);
    expect(describeTool(pairs[0]!.name!, pairs[0]!.args).name).toBe("deep-research");
  });
});

describe("describeTool", () => {
  it("names the skill rather than the builtin that loaded it", () => {
    expect(describeTool("Skill", JSON.stringify({ skill_name: "deep-research" }))).toEqual({
      kind: "skill",
      name: "deep-research",
    });
  });

  it("names the agent a transfer went to", () => {
    expect(describeTool("transfer_to_agent", JSON.stringify({ agent_name: "researcher" }))).toEqual(
      { kind: "agent", name: "researcher" },
    );
  });

  it("names every agent a dispatch ran", () => {
    expect(
      describeTool(
        "dispatch_agents",
        JSON.stringify({ tasks: [{ agent_name: "a" }, { agent_name: "b" }] }),
      ),
    ).toEqual({ kind: "agents", name: "a, b" });
  });

  it("calls anything else a tool, under its own name", () => {
    expect(describeTool("memory_search")).toEqual({ kind: "tool", name: "memory_search" });
  });

  /**
   * What a stored row actually holds. The engine decorates a *result*'s name
   * with what it acted on, and the arguments that would say the same thing live
   * on another message — so a row read on its own has only this. Matching the
   * whole string against the bare builtin name labelled every skill and every
   * hand-off a plain "tool", which is how it looked in a browser.
   */
  it("reads the engine's decorated result name", () => {
    expect(describeTool("Skill: tech-spec")).toEqual({ kind: "skill", name: "tech-spec" });
    expect(describeTool("transfer_to_agent: simple-llm")).toEqual({
      kind: "agent",
      name: "simple-llm",
    });
  });

  it("prefers the arguments over the decoration when it has both", () => {
    expect(describeTool("Skill: stale", JSON.stringify({ skill_name: "fresh" }))).toEqual({
      kind: "skill",
      name: "fresh",
    });
  });

  /** An MCP tool is free to contain a colon; its first half is not a builtin. */
  it("leaves a colon in an ordinary tool's name alone", () => {
    expect(describeTool("aws:search_documentation")).toEqual({
      kind: "tool",
      name: "aws:search_documentation",
    });
    expect(describeTool("server: lookup")).toEqual({ kind: "tool", name: "server: lookup" });
  });

  /** Args arrive a character at a time, so half of one is the normal case. */
  it("falls back to the tool's name when the arguments cannot be read", () => {
    expect(describeTool("Skill", '{"skill_name": "deep-rese')).toEqual({
      kind: "skill",
      name: "Skill",
    });
  });
});

describe("storedToolArgs", () => {
  function message(partial: Partial<ChatMessage> & { seq: number; role: string }): ChatMessage {
    return { chatId: "c1", content: "", createdAt: "", ...partial } as ChatMessage;
  }

  /**
   * A stored tool row keeps the result and the tool's name; which *skill* ran is
   * on the assistant message that declared the call. Storage order within a run
   * is `tool… → assistant`, the reverse of the wire.
   */
  it("finds the arguments on the assistant message that declared the call", () => {
    const args = storedToolArgs([
      message({ seq: 0, role: "user", content: "hi" }),
      message({ seq: 1, role: "tool", toolCallId: "call_1", toolName: "Skill", content: "…" }),
      message({
        seq: 2,
        role: "assistant",
        content: "done",
        toolCalls: [wireCall("call_1", "Skill", '{"skill_name":"deep-research"}')] as never,
      }),
    ]);
    expect(args.get(1)).toBe('{"skill_name":"deep-research"}');
  });

  /**
   * Ids are unique only within the run that produced them — the engine
   * synthesizes them for providers that omit them and the counter restarts — so
   * a later run's call must not name an earlier run's row.
   */
  it("does not let one run's call answer another run's row", () => {
    const args = storedToolArgs([
      message({ seq: 0, role: "user", content: "first" }),
      message({ seq: 1, role: "tool", toolCallId: "call_1", toolName: "Skill", content: "…" }),
      message({ seq: 2, role: "assistant", content: "a" }),
      message({ seq: 3, role: "user", content: "second" }),
      message({
        seq: 4,
        role: "assistant",
        content: "b",
        toolCalls: [wireCall("call_1", "Skill", '{"skill_name":"other"}')] as never,
      }),
    ]);
    expect(args.has(1)).toBe(false);
  });

  it("leaves a row alone when nothing declared it", () => {
    const args = storedToolArgs([
      message({ seq: 0, role: "user", content: "hi" }),
      message({ seq: 1, role: "tool", toolCallId: "orphan", toolName: "Skill", content: "…" }),
      message({ seq: 2, role: "assistant", content: "done" }),
    ]);
    expect(args.size).toBe(0);
  });
});
