import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { ChatSidebarItems } from "@/app/chats/_components/ChatSidebarItems";
import { translator } from "@/app/_i18n/translate";
import { useT } from "@/app/_i18n/provider";

vi.mock("@/app/_i18n/provider", () => ({ useT: vi.fn() }));

describe("Chat and Workspace navigation", () => {
  it.each(["en", "ko"] as const)("preserves links and active state for a tab's rows in %s", locale => {
    const t = translator(locale);
    vi.mocked(useT).mockReturnValue(t);
    const base = { ownerEmail: "owner@example.test", createdAt: "", updatedAt: "" };
    const chats = [
        { ...base, chatId: "ws-ordinary-chat", title: "Discuss changes" },
        { ...base, chatId: "result-chat", title: "Implement changes", workspaceId: "workspace-1" },
        { ...base, chatId: "older-chat", title: "Earlier discussion" },
    ];
    const render = (tab: "chats" | "workspaces", rows: typeof chats) => renderToStaticMarkup(createElement(MantineProvider, { children: createElement(ChatSidebarItems, {
      chats: rows, tab, activeId: "result-chat", running: [], onDelete: vi.fn(),
    }) }));
    const workspaces = render("workspaces", [chats[1]!]);
    expect(workspaces).toContain('href="/chats/result-chat"');
    expect(workspaces).toContain('aria-current="page"');
    expect(workspaces).toContain(`aria-label="${t("workspace.delete")}"`);
    expect(workspaces).not.toContain("Discuss changes");
    const conversations = render("chats", [chats[0]!, chats[2]!]);
    expect(conversations).toContain('href="/chats/ws-ordinary-chat"');
    expect(conversations.indexOf("Discuss changes")).toBeLessThan(conversations.indexOf("Earlier discussion"));
    expect(conversations).not.toContain("Implement changes");
  });
});
