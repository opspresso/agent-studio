import { withConfigurations } from "./projectConfigurations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChatApproval, resumeChatApproval, discardChatApproval } from "@/application/chat/approval";
import { sendMessage } from "@/application/chat/sendMessage";
import type { ChatDeps } from "@/application/chat/deps";
import type { ActiveChatRun, Chat, ChatMessage } from "@/domain/chat/types";
import type { Project } from "@/domain/project/types";
import { runtimeSessionFixture } from "./runtimeSessionFixture";
import { FakeChannel, contentChunk, toolCallChunk } from "./fakeChannel";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T00:00:00Z")); });
afterEach(() => vi.useRealTimers());

async function fixture() {
  const f = runtimeSessionFixture({ approvalTools: ["lookup"] });
  const effect = vi.fn(async () => ({ text: "looked up" }));
  const tools = [{ type: "function" as const, function: { name: "lookup", parameters: {} } }];
  await f.run(new FakeChannel([[toolCallChunk(0, "call", "lookup", "{}")]]), "lookup", undefined, { callMcpTool: effect }, { mcpTools: tools });
  const chat: Chat = { chatId: f.scope.sessionId, ownerEmail: f.scope.ownerEmail, projectName: f.scope.projectName, title: "Chat", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z" };
  const project: Project = { name: f.scope.projectName, ownerEmail: f.scope.ownerEmail, displayName: "Project", description: "",  createdAt: chat.createdAt, updatedAt: chat.updatedAt };
  const messages: ChatMessage[] = [];
  const order: string[] = [];
  let active: ActiveChatRun | null = null;
  let seq = 0;
  const channel = new FakeChannel([[contentChunk("done")]]);
  const chats = {
    get: vi.fn(async () => chat), listByOwner: async () => [chat], create: async () => {}, update: async () => {}, delete: async () => {},
    listMessages: async () => messages,
    claimRun: vi.fn(async (_chatId: string, runId: string, _now: number, expiresAtSeconds: number) => { if (active) return false; active = { runId, expiresAtSeconds }; return true; }),
    releaseRun: vi.fn(async () => { order.push("release"); active = null; }),
    getActiveRun: async () => active, requestCancel: async () => true,
    reserveMessageSeq: vi.fn(async () => seq++), appendMessage: async (message: ChatMessage) => { order.push("persist"); messages.push(message); },
  };
  const deps = {
    chats, runtimeSessions: f.services,
    projects: withConfigurations({ get: async () => project }, ({ get: async () => f.configuration }).get),
    runLog: { append: async (_chat: string, _run: string, entries: Array<{ terminal?: boolean }>) => { if (entries.some((entry) => entry.terminal)) order.push("terminal"); }, read: async () => [] },
    documents: { extract: async () => ({ text: "" }) },
    runAgent: async function* (input: Parameters<ChatDeps["runAgent"]>[0]) {
      for (const chunk of await f.run(channel, "", input.resumeApproval, { callMcpTool: effect }, { mcpTools: tools })) yield chunk;
    },
  } as unknown as ChatDeps;
  const pending = (await getChatApproval(deps, chat.chatId, chat.ownerEmail))!;
  const input = { chatId: chat.chatId, userEmail: chat.ownerEmail, revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] };
  return { ...f, chat, project, deps, chats, messages, order, effect, channel, input };
}

describe("chat approval ownership and lifecycle", () => {
  it("reports missing or expired native history when continuing an existing chat", async () => {
    const f = await fixture();
    f.rows.clear();
    const run = await sendMessage(f.deps, { chatId: f.chat.chatId, userEmail: f.chat.ownerEmail, content: "continue" });
    const chunks: unknown[] = [];
    for await (const chunk of run.stream) chunks.push(chunk);
    expect(chunks).toContainEqual({ warning: "Earlier chat records are visible, but this chat has no saved SDK Session. This run starts a new model context." });
  });

  it("hides a pending approval and all mutations from a non-owner", async () => {
    const f = await fixture();
    const read = vi.spyOn(f.services.repository, "get");
    await expect(getChatApproval(f.deps, f.chat.chatId, "other@example.com")).rejects.toMatchObject({ status: 404 });
    await expect(resumeChatApproval(f.deps, { ...f.input, userEmail: "other@example.com" })).rejects.toMatchObject({ status: 404 });
    await expect(discardChatApproval(f.deps, f.chat.chatId, "other@example.com", f.input.revision)).rejects.toMatchObject({ status: 404 });
    expect(read).not.toHaveBeenCalled();
    expect(f.chats.claimRun).not.toHaveBeenCalled();
  });

  it.each([true, false])("resumes the SDK decision approve=%s without inserting a user turn", async (approve) => {
    const f = await fixture();
    const result = await resumeChatApproval(f.deps, { ...f.input, decisions: [{ ...f.input.decisions[0]!, approve }] });
    result.onClientGone();
    for await (const chunk of result.stream) expect(chunk).not.toHaveProperty("error");
    expect(f.effect).toHaveBeenCalledTimes(approve ? 1 : 0);
    expect(f.messages.some((row) => row.role === "user")).toBe(false);
    expect(f.messages.some((row) => row.role === "assistant" && row.content === "done")).toBe(true);
    expect(f.order.indexOf("persist")).toBeLessThan(f.order.indexOf("terminal"));
    expect(f.order.indexOf("terminal")).toBeLessThan(f.order.indexOf("release"));
    await expect(resumeChatApproval(f.deps, f.input)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses stale revisions and revoked project access before a run lease", async () => {
    const f = await fixture();
    await expect(resumeChatApproval(f.deps, { ...f.input, revision: f.input.revision - 1 })).rejects.toMatchObject({ status: 409 });
    f.project.ownerEmail = "other@example.com";
    f.project.visibility = "private";
    await expect(resumeChatApproval(f.deps, f.input)).rejects.toMatchObject({ status: 403 });
    expect(f.chats.claimRun).not.toHaveBeenCalled();
    expect(f.effect).not.toHaveBeenCalled();
  });

  it("refuses to discard an active run and discards only the selected pending revision", async () => {
    const f = await fixture();
    await f.chats.claimRun(f.chat.chatId, "active", 0, Math.floor(Date.now() / 1000) + 600);
    await expect(discardChatApproval(f.deps, f.chat.chatId, f.chat.ownerEmail, f.input.revision)).rejects.toMatchObject({ status: 409 });
    await f.chats.releaseRun();
    await discardChatApproval(f.deps, f.chat.chatId, f.chat.ownerEmail, f.input.revision);
    expect(await getChatApproval(f.deps, f.chat.chatId, f.chat.ownerEmail)).toBeNull();
    expect(f.effect).not.toHaveBeenCalled();
  });
});
