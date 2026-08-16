/**
 * `RunOrigin.conversation` — the key that lets a run say which thread it is in.
 *
 * Two consumers were waiting on it: an outbound A2A transfer, which continues
 * a remote conversation by `contextId`, and the MCP header that tells a
 * stateful server (a memory server) which conversation is asking. Both read
 * the same key, built by one function per surface, normalised in one place.
 */

// The API surface keys its caller digest with the deployment's own secret.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

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
import { ValidationError } from "@/application/errors";
import { createTraceRecorder } from "@/application/run/traceLifecycle";
import type { Trace } from "@/domain/trace/types";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Project, Version } from "@/domain/project/types";

describe("conversationOf", () => {
  it("keeps a plain id as it is, under its surface", () => {
    expect(conversationOf("chat", "0d1e-4f")).toEqual({ surface: "chat", id: "0d1e-4f" });
    expect(conversationKey({ surface: "chat", id: "0d1e-4f" })).toBe("chat:0d1e-4f");
  });

  it("makes a foreign id safe for a header and a key, without merging two ids into one", () => {
    // Whitespace and control characters cannot travel in a header and would sit
    // invisibly in a storage key; anything past printable ASCII likewise. Each
    // becomes its bytes, so the encoding reads back to exactly one id.
    expect(conversationOf("a2a", "ctx 1\r\nX-Injected: yes")).toEqual({
      surface: "a2a",
      id: "ctx%201%0D%0AX-Injected:%20yes",
    });
    expect(conversationOf("api", "회의-1")?.id).toBe("%ED%9A%8C%EC%9D%98-1");
    expect(conversationOf("api", "회신-1")?.id).not.toBe(conversationOf("api", "회의-1")?.id);
    // `%` is encoded too, or a caller could spell somebody else's encoding.
    expect(conversationOf("api", "%ED%9A%8C")?.id).toBe("%25ED%259A%258C");
    // A safe id — a UUID, a Slack address — reads back unchanged.
    expect(conversationOf("slack", "C01:1723.45")?.id).toBe("C01:1723.45");
  });

  it("answers null rather than an empty or a shortened conversation", () => {
    expect(conversationOf("api", "")).toBeNull();
    expect(conversationOf("api", "   ")).toBeNull();
    expect(conversationOf("api", undefined)).toBeNull();
    // Past the bound there is no conversation, not a truncated one that two
    // long ids would share.
    expect(conversationOf("api", "a".repeat(512))?.id).toHaveLength(512);
    expect(conversationOf("api", "a".repeat(513))).toBeNull();
    expect(conversationOf("api", "회".repeat(60))).toBeNull();
  });
});

describe("the surfaces' own spellings", () => {
  it("a chat is its id", () => {
    expect(conversationKey(chatConversation("c-1"))).toBe("chat:c-1");
    expect(() => chatConversation("")).toThrow();
  });

  it("a Slack conversation is the thread", () => {
    expect(conversationKey(slackConversation("C01", "1723.45"))).toBe("slack:C01:1723.45");
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

  it("refuses an oversized header out loud rather than dropping the conversation", () => {
    // A caller that declared a conversation and silently ran without one would
    // have no way to know; the loss is a 400 like any other bad input.
    expect(() =>
      requestConversation(request("x".repeat(600)), { kind: "user", id: "a@x.test" }),
    ).toThrow(ValidationError);
    expect(
      requestConversation(request("x".repeat(495)), { kind: "user", id: "a@x.test" })?.id,
    ).toHaveLength(512);
  });

  it("scopes the caller with this deployment's key, so the digest means nothing elsewhere", () => {
    const key = process.env.AES_ENCRYPTION_KEY;
    const before = requestConversation(request("t"), { kind: "user", id: "alice@x.test" });
    process.env.AES_ENCRYPTION_KEY = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");
    try {
      const after = requestConversation(request("t"), { kind: "user", id: "alice@x.test" });
      expect(before?.id).not.toBe(after?.id);
    } finally {
      process.env.AES_ENCRYPTION_KEY = key;
    }
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
      async forget(projectName, agentName, key) {
        rows.delete(`${projectName}|${agentName}|${key}`);
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

  it("a continuation that failed drops its hint, so the next transfer starts cold", async () => {
    const { deps, sent, rows } = fixture([
      { ok: true, text: "first", images: [], contextId: "ctx-old" },
      { ok: false, error: "context ctx-old is unknown" },
      { ok: true, text: "fresh", images: [], contextId: "ctx-new" },
    ]);

    await drain(runRemoteSubagent(deps, "helper", "one", undefined, origin));
    await drain(runRemoteSubagent(deps, "helper", "two", undefined, origin));
    await drain(runRemoteSubagent(deps, "helper", "three", undefined, origin));

    // Sent the hint once, lost it on the failure, and did not resend it — the
    // failed transfer itself is not retried, since the remote may be working.
    expect(sent.map((s) => s.contextId)).toEqual([undefined, "ctx-old", undefined]);
    expect(rows.get("front-desk|helper|slack:C1:1723.45")).toBe("ctx-new");
  });

  it("a lookup that fails costs a cold start, never the transfer", async () => {
    const { deps, sent } = fixture([{ ok: true, text: "fine", images: [] }]);
    const failing = {
      ...deps,
      remoteConversations: {
        get: vi.fn().mockRejectedValue(new Error("table offline")),
        put: vi.fn().mockRejectedValue(new Error("table offline")),
        forget: vi.fn().mockRejectedValue(new Error("table offline")),
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
