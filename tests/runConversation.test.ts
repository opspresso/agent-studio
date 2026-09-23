/**
 * `RunOrigin.conversation` — the key that lets a run say which thread it is in.
 *
 * An MCP header tells a stateful server which conversation is asking.
 * Each surface builds the same kind of key, normalised in one place.
 */

// The API surface keys its caller digest with the deployment's own secret.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { describe, expect, it } from "vitest";
import {
  conversationKey,
  conversationOf,
} from "@/domain/execution/actor";
import { chatConversation } from "@/domain/chat/conversation";
import { slackConversation } from "@/domain/slack/conversation";
import { requestConversation } from "@/app/api/projects/_lib/conversation";
import { ValidationError } from "@/application/errors";
import { createTraceRecorder } from "@/application/run/traceLifecycle";
import type { Trace } from "@/domain/trace/types";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Project, AgentConfiguration } from "@/domain/project/types";

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
    new Request("https://x.test/api/projects/p/agent", {
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

describe("a trace records the conversation key", () => {
  it("as the surface spelled it, absent when there is none", async () => {
    const written: Trace[] = [];
    const traces = {
      put: async (trace: Trace) => {
        written.push(trace);
      },
    } as unknown as TraceRepository;
    const project = { name: "p", projectType: "agent" } as Project;
    const configuration = { projectName: "p", model: "openai/gpt-4o", systemPrompt: "", parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] } satisfies AgentConfiguration;

    await createTraceRecorder(traces, project, configuration, 1, {
      ancestry: ["p"],
      conversation: { surface: "chat", id: "c-1" },
    }).finish();
    await createTraceRecorder(traces, project, configuration, 1, { ancestry: ["p"] }).finish();

    expect(written[0]?.conversation).toBe("chat:c-1");
    expect(written[1]).not.toHaveProperty("conversation");
  });
});
