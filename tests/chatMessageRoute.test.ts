import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatNotFoundError } from "@/application/chat/errors";

const {
  sendMessage,
  watchChatCancel,
  detachedRunResponse,
  retainUntil,
  onClientGone,
  onDrained,
  stream,
  drained,
} = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  watchChatCancel: vi.fn(),
  detachedRunResponse: vi.fn(),
  retainUntil: vi.fn(),
  onClientGone: vi.fn(),
  onDrained: vi.fn(),
  stream: (async function* () {
    yield { delta: { content: "answer" } };
  })(),
  drained: Promise.resolve(),
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    withAuth:
      (handler: (user: unknown, ...args: unknown[]) => Promise<Response>) =>
      (...args: unknown[]) =>
        handler(
          { email: "owner@example.com", name: "Owner", image: null, tier: "member" },
          ...args,
        ),
  };
});

vi.mock("@/app/api/_lib/body", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/_lib/body")>()),
  withTurnBody: async (
    request: Request,
    consume: (
      body: unknown,
      admission: { retainUntil: (completion: PromiseLike<unknown>) => void },
    ) => Promise<Response>,
  ) => consume(await request.json(), { retainUntil }),
}));

vi.mock("@/application/chat/sendMessage", () => ({ sendMessage }));
vi.mock("@/application/chat/cancelRun", () => ({ watchChatCancel }));
vi.mock("@/app/api/chats/_deps", () => ({ chatDeps: { chats: {} } }));
vi.mock("@/app/api/chats/_lib/detachedRun", () => ({ detachedRunResponse }));

const { POST } = await import("@/app/api/chats/[chatId]/messages/route");

const context = { params: Promise.resolve({ chatId: "chat-1" }) };
const request = (body: unknown) =>
  new Request("http://localhost/api/chats/chat-1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(1_250);
  sendMessage.mockResolvedValue({
    runId: "run-1",
    userSeq: 7,
    startedAtMs: 1_000,
    stream,
    onClientGone,
  });
  watchChatCancel.mockReturnValue(onDrained);
  detachedRunResponse.mockResolvedValue({
    response: new Response("detached", { status: 200 }),
    drained,
  });
});

describe("POST /api/chats/{chatId}/messages", () => {
  it("detaches the run and retains a large-body admission until it drains", async () => {
    const response = await POST(request({ content: "hello" }), context);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("detached");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chatId: "chat-1",
        content: "hello",
        userEmail: "owner@example.com",
        caller: { displayName: "Owner" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(watchChatCancel).toHaveBeenCalledWith(
      expect.anything(),
      "chat-1",
      "run-1",
      expect.any(AbortController),
    );
    expect(detachedRunResponse).toHaveBeenCalledWith({
      head: { runId: "run-1", userSeq: 7, elapsedMs: 250 },
      stream,
      onClientGone,
      onDrained,
    });
    expect(retainUntil).toHaveBeenCalledWith(drained);
  });

  it("rejects an empty turn before touching the application", async () => {
    const response = await POST(request({ content: "   " }), context);

    expect(response.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves a typed application status", async () => {
    sendMessage.mockRejectedValueOnce(new ChatNotFoundError());

    const response = await POST(request({ content: "hello" }), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "chat not found" });
    expect(detachedRunResponse).not.toHaveBeenCalled();
  });
});
