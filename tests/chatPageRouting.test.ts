import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/application/errors";

const { forChat } = vi.hoisted(() => ({ forChat: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: async () => ({ email: "reader@example.test" }) }));
vi.mock("@/lib/container", () => ({ workspaceUseCases: { forChat } }));
vi.mock("@/app/chats/_components/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/app/workspaces/_components/WorkspacePanel", () => ({ WorkspacePanel: () => null }));

import ChatPage from "@/app/chats/[chatId]/page";

describe("Chat page routing", () => {
  beforeEach(() => forChat.mockReset());

  it("surfaces a Workspace lookup failure instead of rendering an ordinary Chat", async () => {
    forChat.mockRejectedValueOnce(new Error("Workspace lookup unavailable"));
    await expect(ChatPage({ params: Promise.resolve({ chatId: "chat-1" }) }))
      .rejects.toThrow("Workspace lookup unavailable");
  });

  it("keeps the thread's not-found view for a missing Chat", async () => {
    forChat.mockRejectedValueOnce(new NotFoundError("Chat not found"));
    const page = await ChatPage({ params: Promise.resolve({ chatId: "chat-1" }) });
    expect(page.props.chatId).toBe("chat-1");
  });
});
