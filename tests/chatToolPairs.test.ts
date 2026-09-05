import { describe, expect, it } from "vitest";
import { storedToolArgs } from "@/app/chats/_lib/toolPairs";
import { pairToolTraffic } from "@/app/_lib/toolPairs";
import { describeTool, parseWireToolCall } from "@/app/_lib/toolCalls";
import type { ChatMessage } from "@/domain/chat/types";
import { reduceChunk } from "@/app/chats/_lib/stream";
import { EMPTY_TURN, type StreamChunk } from "@/app/chats/_lib/types";

function wireCall(id: string, name: string, args: string): unknown {
  return { id, type: "function", function: { name, arguments: args } };
}

describe("pairToolTraffic", () => {
  it("keeps reused ids separate across parents, nested paths, and simultaneous transfers", () => {
    const scopes = [
      {},
      { author: "child", authorPath: ["child"], transferId: "first" },
      { author: "child", authorPath: ["child"], transferId: "second" },
      { author: "child", authorPath: ["nested", "child"], transferId: "first" },
    ];
    const chunks: StreamChunk[] = [
      ...scopes.map((scope, index) => ({
        ...scope,
        delta: { toolCalls: [wireCall("call_1", "search", `args-${index}`)] },
      })),
      ...scopes.map((scope, index) => ({
        ...scope,
        toolResult: { toolCallId: "call_1", name: "search", content: `result-${index}` },
      })).toReversed(),
    ];
    const turn = chunks.reduce(reduceChunk, EMPTY_TURN);
    expect(turn.toolCalls[1]).toMatchObject(scopes[1]!);
    expect(turn.tools[0]).toMatchObject(scopes[3]!);
    expect(pairToolTraffic(turn.toolCalls, turn.tools)).toEqual(scopes.map((scope, index) => ({
      name: "search", args: `args-${index}`, content: `result-${index}`, author: scope.author,
    })));
  });

  it("does not attach an orphan child's result to a parent's same-named call", () => {
    expect(pairToolTraffic(
      [{ name: "search", args: "parent" }],
      [{ name: "search", content: "child result", author: "child" }],
    )).toEqual([
      { name: "search", args: "parent" },
      { name: "search", content: "child result", author: "child" },
    ]);
  });

  it("does not use name fallback when both sides identify different calls", () => {
    expect(pairToolTraffic(
      [{ id: "parent", name: "search", args: "parent" }],
      [{ id: "orphan", name: "search", content: "orphan result" }],
    )).toEqual([
      { name: "search", args: "parent" },
      { name: "search", content: "orphan result" },
    ]);
  });

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
   * Which server served an MCP tool only ever reaches the client on the result —
   * a call goes out under the bare name the model used. Keeping the call's name
   * left every row in a running reply saying `get_me`, and it named its server
   * only once the page had reloaded and was reading the stored row instead.
   */
  it("takes the name from the result, which is the one that knows the server", () => {
    expect(
      pairToolTraffic(
        [{ id: "c1", name: "get_me", args: "{}" }],
        [{ id: "c1", name: "github: get_me", content: "octocat" }],
      ),
    ).toEqual([{ id: undefined, name: "github: get_me", args: "{}", content: "octocat" }]);
  });

  it("keeps the call's name while the call is still running", () => {
    expect(pairToolTraffic([{ id: "c1", name: "get_me", args: "{}" }], [])).toEqual([
      { id: undefined, name: "get_me", args: "{}" },
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
   * The regression that made this pairing worth testing. A call would be
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

  /**
   * The half in front of the colon is the MCP server, which the tool's own name
   * never says — `aws___search_documentation` is what the *server* calls it, and
   * a version with several servers attached gives no way to tell them apart.
   */
  it("reads an unknown prefix as the server that served the tool", () => {
    expect(describeTool("aws-knowledge: aws___search_documentation")).toEqual({
      kind: "tool",
      name: "aws___search_documentation",
      source: "aws-knowledge",
    });
  });

  it("leaves an undecorated tool name whole, colons and all", () => {
    expect(describeTool("aws:search_documentation")).toEqual({
      kind: "tool",
      name: "aws:search_documentation",
    });
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

  it("leaves authored and display-only rows without a parent's arguments", () => {
    const args = storedToolArgs([
      message({ seq: 0, role: "user" }),
      message({ seq: 1, role: "tool", toolCallId: "call_1", author: "child" }),
      message({ seq: 2, role: "tool", toolCallId: "call_1", displayOnly: true }),
      message({ seq: 3, role: "tool", toolCallId: "call_1" }),
      message({ seq: 4, role: "assistant", toolCalls: [wireCall("call_1", "search", "parent")] as never }),
    ]);
    expect([...args]).toEqual([[3, "parent"]]);
  });

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
