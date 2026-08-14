/**
 * The `dispatch_agents` builtin: several children at once, their answers
 * collected into one budgeted tool result.
 */

import { describe, expect, it } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import {
  buildAgentTools,
  BUILTIN_TOOL_NAMES,
  DISPATCH_TOOL_NAME,
  runAgent,
  type AgentDeps,
  type RunAgentInput,
} from "@/application/llm/engine";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";

const MODEL = "google/gemini-2.5-flash";

const SUBAGENTS: RunAgentInput["subagents"] = [
  { name: "alpha", description: "A", type: "local" },
  { name: "beta", description: "B", type: "local" },
  { name: "gamma", description: "C", type: "local" },
];

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** A promise this test resolves by hand, so completion order is chosen. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function dispatchTurn(tasks: Array<Record<string, unknown>>) {
  return [
    toolCallChunk(0, "call_d", DISPATCH_TOOL_NAME, JSON.stringify({ tasks })),
    usageChunk(1, 1),
  ];
}

function inputWith(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    projectName: "p",
    model: MODEL,
    systemPrompt: "s",
    messages: [{ role: "user", content: "split this up" }],
    subagents: SUBAGENTS,
    canDispatch: true,
    ...overrides,
  };
}

function dispatchResult(chunks: EngineChunk[]): string {
  return chunks.find((c) => c.toolResult?.name === DISPATCH_TOOL_NAME)?.toolResult?.content ?? "";
}

describe("dispatch_agents", () => {
  it("runs every task at the same time", async () => {
    const gates = new Map([
      ["alpha", gate()],
      ["beta", gate()],
      ["gamma", gate()],
    ]);
    let active = 0;
    let peak = 0;
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      active += 1;
      peak = Math.max(peak, active);
      await gates.get(agentName)?.opened;
      active -= 1;
      yield { author: agentName, delta: { content: `${agentName} spoke` } };
      return `${agentName} answered`;
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "one" },
        { agent_name: "beta", message: "two" },
        { agent_name: "gamma", message: "three" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const pending = collect(
      runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith()),
    );
    // Nothing finishes until the gates open, so a sequential implementation would
    // deadlock here rather than merely be slower.
    for (const held of gates.values()) {
      held.open();
    }
    await pending;

    expect(peak).toBe(3);
  });

  it("collects answers in task order even when they finish out of order", async () => {
    const gates = new Map([
      ["alpha", gate()],
      ["beta", gate()],
      ["gamma", gate()],
    ]);
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      await gates.get(agentName)?.opened;
      yield { author: agentName, delta: { content: agentName } };
      return `${agentName} answered`;
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "one" },
        { agent_name: "beta", message: "two" },
        { agent_name: "gamma", message: "three" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const pending = collect(
      runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith()),
    );
    // Reverse of the request order.
    gates.get("gamma")?.open();
    gates.get("beta")?.open();
    gates.get("alpha")?.open();
    const result = dispatchResult(await pending);

    expect(result.indexOf("### alpha")).toBeLessThan(result.indexOf("### beta"));
    expect(result.indexOf("### beta")).toBeLessThan(result.indexOf("### gamma"));
    expect(result).toContain("alpha answered");
    expect(result).toContain("gamma answered");
  });

  it("reports each child completion before slower siblings finish", async () => {
    const beta = gate();
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      yield { author: agentName, delta: { content: agentName } };
      if (agentName === "beta") {
        await beta.opened;
      }
      return `${agentName} answered`;
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "one" },
        { agent_name: "beta", message: "two" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);
    const stream = runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith());

    const seen: EngineChunk[] = [];
    while (!seen.some((chunk) => chunk.authorDone)) {
      const step = await stream.next();
      if (step.done) {
        break;
      }
      seen.push(step.value);
    }

    expect(seen.at(-1)).toMatchObject({
      author: "alpha",
      authorPath: ["alpha"],
      authorDone: true,
    });
    beta.open();
    await collect(stream);
  });

  it("costs the parent the same two turns however many agents ran", async () => {
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      yield { author: agentName, delta: { content: agentName } };
      return `${agentName} answered`;
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "one" },
        { agent_name: "beta", message: "two" },
        { agent_name: "gamma", message: "three" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    await collect(runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith()));

    // The parent resumed once — three children did not consume three turns.
    expect(channel.seenParams).toHaveLength(2);
  });

  it("refuses the call when two turns do not remain", async () => {
    let started = 0;
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      started += 1;
      yield { author: agentName, delta: { content: agentName } };
      return "answered";
    };
    const channel = new FakeChannel([
      dispatchTurn([{ agent_name: "alpha", message: "one" }]),
      [contentChunk("unused"), usageChunk(1, 1)],
    ]);

    const chunks = await collect(
      runAgent(
        { channel, recordUsage: async () => {}, runSubagent },
        inputWith({ maxTurn: 2 }),
      ),
    );

    expect(dispatchResult(chunks)).toContain("max_turn reached");
    expect(started).toBe(0);
  });

  it("keeps the answers of the tasks that worked when one fails", async () => {
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      if (agentName === "beta") {
        yield { author: agentName, error: "beta is unreachable" };
        return "";
      }
      yield { author: agentName, delta: { content: agentName } };
      return `${agentName} answered`;
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "one" },
        { agent_name: "beta", message: "two" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const result = dispatchResult(
      await collect(runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith())),
    );

    expect(result).toContain("alpha answered");
    expect(result).toContain("beta is unreachable");
    // A partial failure is not a failed call: the trace reads this prefix.
    expect(result.startsWith("Error:")).toBe(false);
  });

  it("keeps a child's answer when it recovered from a nested failure", async () => {
    // An `error` chunk in a child's stream does not mean the child is done. A
    // nested transfer it could not reach comes back to it as a tool error, and it
    // may answer from that — so the returned text has to win over the chunk.
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      yield {
        author: "grandchild",
        authorPath: [agentName, "grandchild"],
        error: "grandchild is unreachable",
      };
      yield { author: agentName, delta: { content: "recovered" } };
      return `${agentName} recovered and answered`;
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "one" },
        { agent_name: "beta", message: "two" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const result = dispatchResult(
      await collect(runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith())),
    );

    expect(result).toContain("alpha recovered and answered");
    expect(result).toContain("beta recovered and answered");
    // Every task recovered, so nothing about this call failed.
    expect(result.startsWith("Error:")).toBe(false);
    expect(result).not.toContain("grandchild is unreachable");
  });

  it("reports a failed call only when no agent produced an answer", async () => {
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      yield { author: agentName, error: `${agentName} is unreachable` };
      return "";
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "one" },
        { agent_name: "beta", message: "two" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const result = dispatchResult(
      await collect(runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith())),
    );

    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("alpha is unreachable");
    expect(result).toContain("beta is unreachable");
  });

  it("splits the turn budget evenly, so a long first answer cannot starve the rest", async () => {
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      yield { author: agentName, delta: { content: agentName } };
      // Far past the whole turn's budget, let alone this task's share.
      return agentName === "alpha" ? "A".repeat(400_000) : "beta answered in full";
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "one" },
        { agent_name: "beta", message: "two" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const result = dispatchResult(
      await collect(runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith())),
    );

    expect(result).toContain("truncated");
    // The point of the even split: the second task still has its answer.
    expect(result).toContain("beta answered in full");
  });

  /**
   * The split has to be over what the turn has *left*. A dispatch is one call
   * among however many the model made in the same response, so sizing the
   * shares against the per-turn cap builds a group bigger than the budget and
   * the single fit then cuts it from the tail — erasing exactly the later tasks
   * the even split exists to protect.
   */
  it("splits what the turn has left, not what it started with", async () => {
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      yield { author: agentName, delta: { content: agentName } };
      return `${agentName}:${"x".repeat(30_000)}`;
    };
    // Spends most of this turn's tool-result budget before the dispatch runs.
    const callMcpTool = async () => ({ text: "y".repeat(150_000) });
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "call_m", "big_tool", "{}"),
        toolCallChunk(
          1,
          "call_d",
          DISPATCH_TOOL_NAME,
          JSON.stringify({
            tasks: [
              { agent_name: "alpha", message: "one" },
              { agent_name: "beta", message: "two" },
              { agent_name: "gamma", message: "three" },
            ],
          }),
        ),
        usageChunk(1, 1),
      ],
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const result = dispatchResult(
      await collect(
        runAgent(
          { channel, recordUsage: async () => {}, runSubagent, callMcpTool },
          inputWith(),
        ),
      ),
    );

    // Every task keeps its section and its own answer. Sized against the cap
    // instead, the group overran what was left and the last task vanished
    // heading and all.
    for (const agentName of ["alpha", "beta", "gamma"]) {
      expect(result).toContain(`### ${agentName}`);
      expect(result).toContain(`${agentName}:xxx`);
    }
  });

  /**
   * A task that ran and failed reports child- or provider-written text, whose
   * length nothing on this side decides. Left out of the accounting, one long
   * error inflated the group past what the turn had left and the final fit
   * cut the tail — erasing the good answers the even split exists to protect.
   */
  it("fits a runtime failure's reason to its share instead of letting it evict the answers", async () => {
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      if (agentName === "alpha") {
        yield { author: agentName, error: `alpha exploded: ${"E".repeat(300_000)}` };
        return "";
      }
      yield { author: agentName, delta: { content: agentName } };
      return `beta:${"x".repeat(50_000)}`;
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "one" },
        { agent_name: "beta", message: "two" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const result = dispatchResult(
      await collect(runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith())),
    );

    // The failure keeps its reason — cut to its share, and saying so.
    expect(result).toContain("Error: alpha exploded:");
    expect(result).toContain("truncated");
    // The other task's answer survives whole.
    expect(result).toContain(`beta:${"x".repeat(50_000)}`);
  });

  /**
   * The marker `fit` appends lands on top of what it kept. Unreserved, a group
   * of long answers outgrew the budget by a few hundred chars and the final
   * fit re-cut the tail, leaving two contradictory truncation claims.
   */
  it("assembles a group that fits the turn budget, truncation markers included", async () => {
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      yield { author: agentName, delta: { content: agentName } };
      return "A".repeat(400_000);
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "one" },
        { agent_name: "beta", message: "two" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const result = dispatchResult(
      await collect(runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith())),
    );

    // Both sections cut to their share, each saying so once — a third claim
    // would be the final fit re-cutting what the shares already cut.
    expect(result).toContain("### alpha");
    expect(result).toContain("### beta");
    expect((result.match(/…\(truncated/g) ?? []).length).toBe(2);
    // Within the cap: nothing left for the final fit to re-cut.
    expect(result.length).toBeLessThanOrEqual(200_000);
  });

  it("refuses tasks past the width limit instead of dropping them", async () => {
    const started: string[] = [];
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      started.push(agentName);
      yield { author: agentName, delta: { content: agentName } };
      return `${agentName} answered`;
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "alpha", message: "1" },
        { agent_name: "beta", message: "2" },
        { agent_name: "gamma", message: "3" },
        { agent_name: "alpha", message: "4" },
        { agent_name: "beta", message: "5" },
        { agent_name: "gamma", message: "6" },
      ]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const result = dispatchResult(
      await collect(runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith())),
    );

    expect(started).toHaveLength(4);
    // Said, not silently shortened — otherwise the model answers for work that
    // never ran.
    expect(result).toContain("not run");
  });

  it("refuses a task naming an agent the run never offered, and runs the rest", async () => {
    const started: string[] = [];
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      started.push(agentName);
      yield { author: agentName, delta: { content: agentName } };
      return `${agentName} answered`;
    };
    const channel = new FakeChannel([
      dispatchTurn([
        { agent_name: "nope", message: "one" },
        { agent_name: "beta", message: "two" },
      ]),
      [contentChunk("done"), usageChunk(1, 1)],
    ]);

    const result = dispatchResult(
      await collect(runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith())),
    );

    expect(started).toEqual(["beta"]);
    expect(result).toContain("'nope' is not connected");
    expect(result).toContain("Available agents: alpha, beta, gamma");
    expect(result).toContain("beta answered");
    // One task refused is not a failed call — the other answered.
    expect(result.startsWith("Error:")).toBe(false);
  });

  it("rejects a task with no agent_name without cancelling the others", async () => {
    const runSubagent: NonNullable<AgentDeps["runSubagent"]> = async function* (agentName) {
      yield { author: agentName, delta: { content: agentName } };
      return `${agentName} answered`;
    };
    const channel = new FakeChannel([
      dispatchTurn([{ agent_name: "alpha", message: "one" }, { message: "no agent" }]),
      [contentChunk("all done"), usageChunk(1, 1)],
    ]);

    const result = dispatchResult(
      await collect(runAgent({ channel, recordUsage: async () => {}, runSubagent }, inputWith())),
    );

    expect(result).toContain("alpha answered");
    expect(result).toContain("each task needs agent_name");
  });
});

describe("dispatch_agents is offered only to a top-level run", () => {
  const names = (canDispatch: boolean) =>
    buildAgentTools({
      skills: [],
      subagents: SUBAGENTS ?? [],
      canLoadSkills: false,
      withImageTool: false,
      withEditTool: false,
      withSlackTools: false,
      withImageTransfer: false,
      withUrlTool: false,
      canDispatch,
    }).tools.map((tool) => tool.function.name);

  it("offers it alongside the transfer tool at the top level", () => {
    expect(names(true)).toEqual(["transfer_to_agent", DISPATCH_TOOL_NAME]);
  });

  it("withholds it from a subagent run", () => {
    // A child that could dispatch would multiply concurrent runs by transfer
    // depth, and those runs are outside the run bracket's guards.
    expect(names(false)).toEqual(["transfer_to_agent"]);
  });

  it("reserves the name so an MCP tool called dispatch_agents stays reachable", () => {
    expect(BUILTIN_TOOL_NAMES).toContain(DISPATCH_TOOL_NAME);
  });
});
