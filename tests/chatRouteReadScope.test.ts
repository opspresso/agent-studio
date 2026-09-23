import { describe, expect, it, vi } from "vitest";
import { CHAT_MESSAGE_PAGE_SIZE } from "@/application/chat/messageList";

// Route-handler test: the repositories behind `chatDeps` are mocked, so the
// assertions are about what these two routes *decide* — how they read the
// query string, and what they pass on. Both decisions are parsing, and both
// have a silent wrong answer: an absent parameter read as a number is `0`,
// which is a valid sequence and a valid-looking page size.
const { chats } = vi.hoisted(() => ({
  chats: {
    get: vi.fn(),
    listByOwner: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    getActiveRun: vi.fn(async () => null),
  },
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    withAuth:
      (handler: (user: unknown, ...args: unknown[]) => Promise<Response>) =>
      (...args: unknown[]) =>
        handler({ email: "owner@x.com", name: "o", tier: "member" }, ...args),
  };
});

vi.mock("@/app/api/chats/_deps", () => ({ chatDeps: { chats } }));

const { GET: listGet } = await import("@/app/api/chats/route");
const { GET: readGet } = await import("@/app/api/chats/[chatId]/route");

const context = { params: Promise.resolve({ chatId: "c1" }) };

function chat() {
  return {
    chatId: "c1",
    title: "t",
    ownerEmail: "owner@x.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("GET /api/chats", () => {
  it("bounds the read when no limit is asked for", async () => {
    chats.listByOwner.mockClear();
    await listGet(new Request("http://x/api/chats"));
    expect(chats.listByOwner).toHaveBeenCalledWith("owner@x.com", { limit: 50 });
  });

  it("honours a limit, and caps how large one may be", async () => {
    chats.listByOwner.mockClear();
    await listGet(new Request("http://x/api/chats?limit=7"));
    expect(chats.listByOwner).toHaveBeenCalledWith("owner@x.com", { limit: 7 });
    await listGet(new Request("http://x/api/chats?limit=100000"));
    expect(chats.listByOwner).toHaveBeenLastCalledWith("owner@x.com", { limit: 500 });
  });

  it("narrows each tab before paging and rejects unknown kinds", async () => {
    chats.listByOwner.mockClear();
    await listGet(new Request("http://x/api/chats?kind=chat&limit=7"));
    expect(chats.listByOwner).toHaveBeenLastCalledWith("owner@x.com", { kind: "chat", limit: 7 });
    await listGet(new Request("http://x/api/chats?kind=workspace&limit=7"));
    expect(chats.listByOwner).toHaveBeenLastCalledWith("owner@x.com", { kind: "workspace", limit: 7 });
    const invalid = await listGet(new Request("http://x/api/chats?kind=unknown"));
    expect(invalid.status).toBe(400);
    expect(chats.listByOwner).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default rather than reading nonsense as a page size", async () => {
    chats.listByOwner.mockClear();
    await listGet(new Request("http://x/api/chats?limit="));
    expect(chats.listByOwner).toHaveBeenCalledWith("owner@x.com", { limit: 50 });
    await listGet(new Request("http://x/api/chats?limit=nope"));
    expect(chats.listByOwner).toHaveBeenCalledWith("owner@x.com", { limit: 50 });
    await listGet(new Request("http://x/api/chats?limit=0"));
    expect(chats.listByOwner).toHaveBeenLastCalledWith("owner@x.com", { limit: 50 });
  });

  it("settles at the ceiling rather than offering more forever", async () => {
    // 600 chats, sidebar already at the cap: the server can only ever answer
    // with 500, so comparing against what came back would keep the button on
    // screen and keep the list the same size every time it is pressed.
    chats.listByOwner.mockResolvedValueOnce(Array.from({ length: 500 }, chat) as never);
    const capped = await listGet(new Request("http://x/api/chats?limit=550"));
    expect(chats.listByOwner).toHaveBeenLastCalledWith("owner@x.com", { limit: 500 });
    expect(await capped.json()).toMatchObject({ hasMore: false });
  });

  it("says whether asking for more could return more", async () => {
    chats.listByOwner.mockResolvedValueOnce([chat(), chat()] as never);
    const full = await listGet(new Request("http://x/api/chats?limit=2"));
    expect(await full.json()).toMatchObject({ hasMore: true });

    chats.listByOwner.mockResolvedValueOnce([chat()] as never);
    const short = await listGet(new Request("http://x/api/chats?limit=2"));
    expect(await short.json()).toMatchObject({ hasMore: false });
  });
});

describe("GET /api/chats/{chatId}", () => {
  it("reads the whole transcript when no bound is given", async () => {
    chats.get.mockResolvedValue(chat() as never);
    chats.listMessages.mockClear();
    await readGet(new Request("http://x/api/chats/c1"), context);
    expect(chats.listMessages).toHaveBeenCalledWith("c1", { limit: CHAT_MESSAGE_PAGE_SIZE });
  });

  it("passes a tail bound through", async () => {
    chats.get.mockResolvedValue(chat() as never);
    chats.listMessages.mockClear();
    await readGet(new Request("http://x/api/chats/c1?sinceSeq=3"), context);
    expect(chats.listMessages).toHaveBeenCalledWith("c1", {
      sinceSeq: 3,
      limit: CHAT_MESSAGE_PAGE_SIZE,
    });
  });

  it("treats sinceSeq=0 as the bound it is, not as an absent one", async () => {
    chats.get.mockResolvedValue(chat() as never);
    chats.listMessages.mockClear();
    await readGet(new Request("http://x/api/chats/c1?sinceSeq=0"), context);
    expect(chats.listMessages).toHaveBeenCalledWith("c1", {
      sinceSeq: 0,
      limit: CHAT_MESSAGE_PAGE_SIZE,
    });
  });

  it("reads an empty sinceSeq as absent, not as zero", async () => {
    // `Number("")` is 0, and 0 is the first message's sequence: parsed that
    // way, `?sinceSeq=` would answer with the transcript minus its opening
    // turn.
    chats.get.mockResolvedValue(chat() as never);
    chats.listMessages.mockClear();
    await readGet(new Request("http://x/api/chats/c1?sinceSeq="), context);
    expect(chats.listMessages).toHaveBeenCalledWith("c1", { limit: CHAT_MESSAGE_PAGE_SIZE });
  });

  it("ignores a bound it cannot read rather than refusing the request", async () => {
    chats.get.mockResolvedValue(chat() as never);
    chats.listMessages.mockClear();
    await readGet(new Request("http://x/api/chats/c1?sinceSeq=nope"), context);
    expect(chats.listMessages).toHaveBeenCalledWith("c1", { limit: CHAT_MESSAGE_PAGE_SIZE });
    await readGet(new Request("http://x/api/chats/c1?sinceSeq=-2"), context);
    expect(chats.listMessages).toHaveBeenLastCalledWith("c1", {
      limit: CHAT_MESSAGE_PAGE_SIZE,
    });
  });
});
