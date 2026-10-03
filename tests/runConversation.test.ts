import { executionIdentity } from "./runIdentity";
/**
 * `RunOrigin.conversation` — the key that lets a run say which thread it is in.
 *
 * An MCP header tells a stateful server which conversation is asking.
 * Each surface builds the same kind of key, normalised in one place.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ids = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++ids.sequence).padStart(12, "0")}`,
}));
import {
  conversationKey,
  conversationOf,
} from "@/domain/execution/actor";
import { chatConversation } from "@/domain/chat/conversation";
import { slackConversation } from "@/domain/slack/conversation";
import { requestConversation } from "@/app/api/agents/_lib/conversation";
import { ValidationError } from "@/application/errors";
import { createTraceRecorder } from "@/application/run/traceLifecycle";
import type { Trace } from "@/domain/trace/types";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Agent } from "@/domain/agent/types";

beforeEach(() => {
  ids.sequence = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-01-01T00:00:00.000Z");
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("conversationOf", () => {
  it("keeps a plain id as it is, under its surface", () => {
    expect(conversationOf("chat", "0d1e-4f")).toEqual({ surface: "chat", id: "0d1e-4f" });
    expect(conversationKey({ surface: "chat", id: "0d1e-4f" })).toBe("chat:0d1e-4f");
  });

  it("makes a foreign id safe for a header and a key, without merging two ids into one", () => {
    // Whitespace and control characters cannot travel in a header and would sit
    // invisibly in a storage key; anything past printable ASCII likewise. Each
    // becomes its bytes, so the encoding reads back to exactly one id.
    expect(conversationOf("api", "ctx 1\r\nX-Injected: yes")).toEqual({
      surface: "api",
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

  it.each(["\ud800", "\ud801", "\udfff", "thread-\ud800"])("refuses malformed Unicode IDs instead of merging them with replacement characters", id => {
    expect(conversationOf("teams", id)).toBeNull();
    expect(conversationOf("teams", "\ufffd")?.id).toBe("%EF%BF%BD");
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


});

describe("requestConversation", () => {
  const request = (value?: string) =>
    new Request("https://x.test/api/agents/p/agent", {
      headers: value === undefined ? {} : { "X-Conversation-Id": value },
    });

  it("is absent when the caller declared none", () => {
    expect(requestConversation(request(), "a-user-id")).toBeNull();
    expect(requestConversation(request("   "), "a-user-id")).toBeNull();
  });

  it("qualifies the caller's id by the caller, without exposing who they are", () => {
    const alice = requestConversation(request("thread-1"), "alice-user-id");
    const bob = requestConversation(request("thread-1"), "bob-user-id");
    expect(alice?.surface).toBe("api");
    expect(alice?.id.endsWith(":thread-1")).toBe(true);
    // Two callers, one header value: two conversations.
    expect(alice?.id).not.toBe(bob?.id);
    // Neither exposes the internal user ID.
    expect(conversationKey(alice!)).not.toContain("alice");
    // Stable: the same caller gets the same key next request.
    expect(requestConversation(request("thread-1"), "alice-user-id")).toEqual(
      alice,
    );
  });

  it("refuses a namespace without an authenticated user ID", () => {
    expect(() => requestConversation(request("thread"), "")).toThrow("authenticated API caller");
  });

  it("refuses an oversized header out loud rather than dropping the conversation", () => {
    // A caller that declared a conversation and silently ran without one would
    // have no way to know; the loss is a 400 like any other bad input.
    expect(() =>
      requestConversation(request("x".repeat(600)), "a-user-id"),
    ).toThrow(ValidationError);
    expect(
      requestConversation(request("x".repeat(495)), "a-user-id")?.id,
    ).toHaveLength(512);
  });

  it("scopes the caller with this deployment's key, so the digest means nothing elsewhere", () => {
    const before = requestConversation(request("t"), "alice-user-id");
    vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 6).toString("base64"));
    const after = requestConversation(request("t"), "alice-user-id");
    expect(before?.id).not.toBe(after?.id);
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
    const agent = { name: "p" } as Agent;

    await createTraceRecorder(traces, agent, { ...executionIdentity(),
      ancestry: ["p"],
      conversation: { surface: "chat", id: "c-1" },
    }).finish();
    await createTraceRecorder(traces, agent, { ...executionIdentity(), ancestry: ["p"] }).finish();

    expect(written[0]?.conversation).toBe("chat:c-1");
    expect(written[1]).not.toHaveProperty("conversation");
  });
});
