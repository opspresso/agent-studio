import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatNotFoundError } from "@/application/chat/errors";

const f = vi.hoisted(() => ({ get: vi.fn(), resume: vi.fn(), discard: vi.fn(), watch: vi.fn(), response: vi.fn(), retainUntil: vi.fn(), gone: vi.fn(), drained: Promise.resolve() }));
vi.mock("@/lib/session", () => ({ withAuth: (handler: (user: unknown, ...args: unknown[]) => Promise<Response>) => (...args: unknown[]) => handler({ email: "owner@example.com" }, ...args) }));
vi.mock("@/app/api/_lib/body", () => ({ withTurnBody: async (request: Request, consume: (body: unknown, admission: unknown) => Promise<Response>) => consume(await request.json(), { retainUntil: f.retainUntil }) }));
vi.mock("@/application/chat/approval", () => ({ getChatApproval: f.get, resumeChatApproval: f.resume, discardChatApproval: f.discard }));
vi.mock("@/application/chat/cancelRun", () => ({ watchChatCancel: f.watch }));
vi.mock("@/app/api/chats/_deps", () => ({ chatDeps: { chats: {} } }));
vi.mock("@/app/api/chats/_lib/detachedRun", () => ({ detachedRunResponse: f.response }));
const { GET, POST, DELETE } = await import("@/app/api/chats/[chatId]/approval/route");
const context = { params: Promise.resolve({ chatId: "chat-1" }) };
const request = (method: string, body?: unknown) => new Request("http://localhost/api/chats/chat-1/approval", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const decision = { revision: 2, decisions: [{ id: "a".repeat(64), approve: true }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(1_250);
  f.get.mockResolvedValue(null);
  f.resume.mockResolvedValue({ runId: "resume-1", startedAtMs: 1_000, stream: (async function* () {})(), onClientGone: f.gone });
  f.watch.mockReturnValue(() => {});
  f.response.mockResolvedValue({ response: new Response("stream"), drained: f.drained });
});

describe("chat approval route", () => {
  it("returns the owner-scoped pending state and preserves typed 404 errors", async () => {
    expect(await (await GET(request("GET"), context)).json()).toEqual({ pending: null });
    expect(f.get).toHaveBeenCalledWith(expect.anything(), "chat-1", "owner@example.com");
    f.get.mockRejectedValueOnce(new ChatNotFoundError());
    expect((await GET(request("GET"), context)).status).toBe(404);
  });

  it("detaches resumed runs and retains admission until their stream drains", async () => {
    expect((await POST(request("POST", decision), context)).status).toBe(200);
    expect(f.resume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ...decision, chatId: "chat-1", userEmail: "owner@example.com", signal: expect.any(AbortSignal) }));
    expect(f.response).toHaveBeenCalledWith(expect.objectContaining({ head: { runId: "resume-1", elapsedMs: 250 }, onClientGone: f.gone, onDrained: expect.any(Function) }));
    expect(f.retainUntil).toHaveBeenCalledWith(f.drained);
  });

  it.each([{ ...decision, revision: 0 }, { ...decision, decisions: [] }, { ...decision, decisions: [{ id: "wrong", approve: true }] }, { ...decision, decisions: [{ id: "a".repeat(64), approve: "yes" }] }])("rejects malformed decisions before creating a run: %j", async (body) => {
    expect((await POST(request("POST", body), context)).status).toBe(400);
    expect(f.resume).not.toHaveBeenCalled();
  });

  it("discards only a valid named revision", async () => {
    expect((await DELETE(request("DELETE", { revision: 2 }), context)).status).toBe(204);
    expect(f.discard).toHaveBeenCalledWith(expect.anything(), "chat-1", "owner@example.com", 2);
    expect((await DELETE(request("DELETE", { revision: -1 }), context)).status).toBe(400);
    expect(f.discard).toHaveBeenCalledTimes(1);
  });
});
