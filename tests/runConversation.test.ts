/**
 * `RunOrigin.conversation` — the key that lets a run say which thread it is in.
 *
 * Two consumers were waiting on it: an outbound A2A transfer, which continues
 * a remote conversation by `contextId`, and the MCP header that tells a
 * stateful server (a memory server) which conversation is asking. Both read
 * the same key, built by one function per surface, normalised in one place.
 */

import { describe, expect, it, vi } from "vitest";
import {
  conversationKey,
  conversationOf,
  type RunOrigin,
} from "@/domain/execution/actor";
import { chatConversation } from "@/domain/chat/conversation";
import { slackConversation } from "@/domain/slack/conversation";
import { a2aConversation } from "@/domain/a2a/conversation";
import { runRemoteSubagent } from "@/application/execution/subagentRunner";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { RemoteAgentDispatcher, RemoteAgentReply } from "@/domain/agent/dispatcher";
import type { RemoteConversationRepository } from "@/domain/agent/remoteConversation";
import type { EngineChunk } from "@/domain/llm/types";
import { requestConversation } from "@/app/api/projects/_lib/conversation";
import { createTraceRecorder } from "@/application/run/traceLifecycle";
import type { Trace } from "@/domain/trace/types";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Project, Version } from "@/domain/project/types";

describe("conversationOf", () => {
  it("keeps a plain id as it is, under its surface", () => {
    expect(conversationOf("chat", "0d1e-4f")).toEqual({ surface: "chat", id: "0d1e-4f" });
    expect(conversationKey({ surface: "chat", id: "0d1e-4f" })).toBe("chat:0d1e-4f");
  });

  it("makes a foreign id safe for a header and a key", () => {
    // Whitespace and control characters cannot travel in a header and would sit
    // invisibly in a storage key; anything past printable ASCII likewise.
    expect(conversationOf("a2a", "ctx 1\r\nX-Injected: yes")).toEqual({
      surface: "a2a",
      id: "ctx_1__X-Injected:_yes",
    });
    // Two code points, two placeholders — the count is not the point, the fact
    // that nothing outside printable ASCII survives is.
    expect(conversationOf("api", "회의-1")?.id).toBe("__-1");
    expect(conversationOf("api", `${"a".repeat(300)}`)?.id).toHaveLength(200);
  });

  it("answers null rather than an empty conversation", () => {
    expect(conversationOf("api", "")).toBeNull();
    expect(conversationOf("api", "   ")).toBeNull();
    expect(conversationOf("api", undefined)).toBeNull();
  });
});

describe("the surfaces' own spellings", () => {
  it("a chat is its id", () => {
    expect(conversationKey(chatConversation("c-1"))).toBe("chat:c-1");
    expect(() => chatConversation("")).toThrow();
  });

  it("a Slack conversation is the thread", () => {
    expect(conversationKey(slackConversation("C01", "1723.45")!)).toBe("slack:C01:1723.45");
  });

  it("an inbound A2A conversation is the contextId under the caller", () => {
    expect(conversationKey(a2aConversation({ kind: "a2a", id: "shared-key" }, "ctx-9")!)).toBe(
      "a2a:shared-key:ctx-9",
    );
    expect(conversationKey(a2aConversation({ kind: "a2a", id: "billing-bot" }, "ctx-9")!)).toBe(
      "a2a:billing-bot:ctx-9",
    );
  });
});

describe("requestConversation", () => {
  const request = (value?: string) =>
    new Request("https://x.test/api/projects/p/versions/v/agent", {
      headers: value === undefined ? {} : { "X-Conversation-Id": value },
    });

  it("is absent when the caller declared none", () => {
    expect(requestConversation(request(), { kind: "user", id: "a@x.test" })).toBeNull();
    expect(requestConversation(request("   "), { kind: "user", id: "a@x.test" })).toBeNull();
  });

  it("qualifies the caller's id by the caller, without exposing who they are", () => {
    const alice = requestConversation(request("thread-1"), { kind: "user", id: "alice@x.test" });
    const bob = requestConversation(request("thread-1"), { kind: "user", id: "bob@x.test" });
    expect(alice?.surface).toBe("api");
    expect(alice?.id.endsWith(":thread-1")).toBe(true);
    // Two callers, one header value: two conversations.
    expect(alice?.id).not.toBe(bob?.id);
    // And neither carries the email it was derived from.
    expect(conversationKey(alice!)).not.toContain("alice");
    // Stable: the same caller gets the same key next request.
    expect(requestConversation(request("thread-1"), { kind: "user", id: "alice@x.test" })).toEqual(
      alice,
    );
  });

  it("refuses an oversized header rather than working on it", () => {
    expect(
      requestConversation(request("x".repeat(600)), { kind: "user", id: "a@x.test" }),
    ).toBeNull();
  });
});

describe("a remote A2A transfer continues the conversation", () => {
  const origin: RunOrigin = {
    ancestry: ["front-desk"],
    conversation: { surface: "slack", id: "C1:1723.45" },
  };

  function fixture(replies: RemoteAgentReply[]) {
    const sent: Array<{ message: string; contextId?: string }> = [];
    const rows = new Map<string, string>();
    const remoteAgents: RemoteAgentDispatcher = {
      async send(_target, message, _signal, options) {
        sent.push({ message, ...(options?.contextId ? { contextId: options.contextId } : {}) });
        return replies.shift() ?? { ok: false, error: "no scripted reply" };
      },
      probe: async () => ({ ok: true, text: "" }),
    };
    const remoteConversations: RemoteConversationRepository = {
      async get(projectName, agentName, key) {
        return rows.get(`${projectName}|${agentName}|${key}`) ?? null;
      },
      async put(projectName, agentName, key, contextId) {
        rows.set(`${projectName}|${agentName}|${key}`, contextId);
      },
    };
    const deps = {
      externalAgents: {
        get: async (name: string) =>
          name === "helper"
            ? {
                name,
                url: "https://helper.test",
                protocol: "a2a" as const,
                description: "",
                headers: {},
                createdAt: "",
                updatedAt: "",
              }
            : null,
      },
      urlPolicy: { async assertAllowed() {} },
      cipher: { decryptHeadersForOutbound: () => ({}) },
      remoteAgents,
      remoteConversations,
    } as unknown as Pick<
      ExecutionDeps,
      "externalAgents" | "urlPolicy" | "cipher" | "remoteAgents" | "remoteConversations"
    >;
    return { deps, sent, rows };
  }

  async function drain(source: AsyncGenerator<EngineChunk, string>) {
    let step = await source.next();
    while (!step.done) {
      step = await source.next();
    }
    return step.value;
  }

  it("opens cold, remembers the remote contextId, and sends it back next time", async () => {
    const { deps, sent, rows } = fixture([
      { ok: true, text: "first", images: [], contextId: "remote-ctx-1" },
      { ok: true, text: "second", images: [], contextId: "remote-ctx-1" },
    ]);

    await drain(runRemoteSubagent(deps, "helper", "hello", undefined, origin));
    await drain(runRemoteSubagent(deps, "helper", "and then?", undefined, origin));

    expect(sent).toEqual([
      { message: "hello" },
      { message: "and then?", contextId: "remote-ctx-1" },
    ]);
    // Keyed by the transferring project, the agent and our own conversation.
    expect(rows.get("front-desk|helper|slack:C1:1723.45")).toBe("remote-ctx-1");
  });

  it("does not remember across conversations, and starts cold without one", async () => {
    const { deps, sent } = fixture([
      { ok: true, text: "a", images: [], contextId: "ctx-a" },
      { ok: true, text: "b", images: [], contextId: "ctx-b" },
      { ok: true, text: "c", images: [] },
    ]);

    await drain(runRemoteSubagent(deps, "helper", "one", undefined, origin));
    await drain(
      runRemoteSubagent(deps, "helper", "two", undefined, {
        ...origin,
        conversation: { surface: "chat", id: "elsewhere" },
      }),
    );
    await drain(runRemoteSubagent(deps, "helper", "three", undefined, { ancestry: ["front-desk"] }));

    expect(sent.map((s) => s.contextId)).toEqual([undefined, undefined, undefined]);
  });

  it("a lookup that fails costs a cold start, never the transfer", async () => {
    const { deps, sent } = fixture([{ ok: true, text: "fine", images: [] }]);
    const failing = {
      ...deps,
      remoteConversations: {
        get: vi.fn().mockRejectedValue(new Error("table offline")),
        put: vi.fn().mockRejectedValue(new Error("table offline")),
      },
    };

    const text = await drain(runRemoteSubagent(failing, "helper", "hello", undefined, origin));

    expect(text).toBe("fine");
    expect(sent).toEqual([{ message: "hello" }]);
  });
});

describe("a trace records the conversation key", () => {
  it("as the surface spelled it, absent when there is none", async () => {
    const written: Trace[] = [];
    const traces = {
      put: async (trace: Trace) => {
        written.push(trace);
      },
    } as unknown as TraceRepository;
    const project = { name: "p", projectType: "agent" } as Project;
    const version = { versionName: "v1", model: "openai/gpt-4o" } as Version;

    await createTraceRecorder(traces, project, version, 1, {
      ancestry: ["p"],
      conversation: { surface: "chat", id: "c-1" },
    }).finish();
    await createTraceRecorder(traces, project, version, 1, { ancestry: ["p"] }).finish();

    expect(written[0]?.conversation).toBe("chat:c-1");
    expect(written[1]).not.toHaveProperty("conversation");
  });
});
