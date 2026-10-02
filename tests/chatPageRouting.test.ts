import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/application/errors";

const { forChat } = vi.hoisted(() => ({ forChat: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: async () => ({ email: "reader@example.test" }) }));
vi.mock("@/lib/container", () => ({ workspaceUseCases: { forChat } }));
vi.mock("@/app/chats/_components/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/app/workspaces/_components/WorkspacePanel", () => ({ WorkspacePanel: () => null }));

import ChatPage from "@/app/chats/[chatId]/page";
import { ChatThread } from "@/app/chats/_components/ChatThread";
import { WorkspacePanel } from "@/app/workspaces/_components/WorkspacePanel";
import { ChatRouteSelection } from "@/app/chats/_components/ChatRouteSelection";

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
    const [selection, thread] = page.props.children;
    expect(selection.type).toBe(ChatRouteSelection);
    expect(selection.props).toEqual({ chatId: "chat-1", tab: "chats" });
    expect(thread.type).toBe(ChatThread);
    expect(thread.props.chatId).toBe("chat-1");
  });

  it("selects Workspaces from the verified lookup independently of the Chat ID format", async () => {
    forChat.mockResolvedValueOnce("workspace-1");
    const page = await ChatPage({ params: Promise.resolve({ chatId: "any-chat-id" }) });
    const [selection, panel] = page.props.children;
    expect(selection.type).toBe(ChatRouteSelection);
    expect(selection.props).toEqual({ chatId: "any-chat-id", tab: "workspaces" });
    expect(panel.type).toBe(WorkspacePanel);
    expect(panel.props.id).toBe("workspace-1");
  });
});
