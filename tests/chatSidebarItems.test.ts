import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { ChatSidebarItems } from "@/app/chats/_components/ChatSidebarItems";
import { translator } from "@/app/_i18n/translate";
import { useT } from "@/app/_i18n/provider";

vi.mock("@/app/_i18n/provider", () => ({ useT: vi.fn() }));

describe("chat and Workspace navigation", () => {
  it.each(["en", "ko"] as const)("separates records by workspaceId, preserving links and active state in %s", locale => {
    const t = translator(locale);
    vi.mocked(useT).mockReturnValue(t);
    const base = { ownerEmail: "owner@example.test", createdAt: "", updatedAt: "" };
    const html = renderToStaticMarkup(createElement(MantineProvider, { children: createElement(ChatSidebarItems, {
      chats: [
        { ...base, chatId: "ws-ordinary-chat", title: "Discuss changes" },
        { ...base, chatId: "result-chat", title: "Implement changes", workspaceId: "workspace-1" },
        { ...base, chatId: "older-chat", title: "Earlier discussion" },
      ], activeId: "result-chat", running: [], onDelete: vi.fn(),
    }) }));
    const sections = [...html.matchAll(/<details\b[^>]*>(.*?)<\/details>/gs)].map(match => match[0]!);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain(`aria-label="${t("workspace.list")}"`);
    expect(sections[0]).toContain('href="/chats/result-chat"');
    expect(sections[0]).toContain('aria-current="page"');
    expect(sections[0]).toContain(`aria-label="${t("workspace.delete")}"`);
    expect(sections[0]).not.toContain("Discuss changes");
    expect(sections[1]).toContain(`aria-label="${t("chat.list")}"`);
    expect(sections[1]).toContain('href="/chats/ws-ordinary-chat"');
    expect(sections[1]!.indexOf("Discuss changes")).toBeLessThan(sections[1]!.indexOf("Earlier discussion"));
    expect(sections[1]).not.toContain("Implement changes");
  });
});
