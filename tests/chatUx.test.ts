import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { NewChatPanel } from "@/app/chats/_components/NewChatPanel";
import { NewChatEntry } from "@/app/chats/_components/NewChatEntry";
import { Composer } from "@/app/chats/_components/Composer";
import { translator } from "@/app/_i18n/translate";
import { useT } from "@/app/_i18n/provider";

vi.mock("@/app/_i18n/provider", () => ({ useT: vi.fn() }));
vi.mock("@/app/chats/_lib/runHooks", () => ({ useRunEntry: () => undefined }));
vi.mock("@/app/chats/_lib/runStore", () => ({ runStore: {} }));
vi.mock("@/app/chats/_components/ChatSidebar", () => ({ onNewChat: vi.fn() }));
vi.mock("@/app/chats/_components/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/app/chats/_components/parts", () => ({
  LiveAssistant: () => null,
  MessageView: () => null,
  RunningAgents: () => null,
}));

function render(children: React.ReactNode) {
  return renderToStaticMarkup(createElement(MantineProvider, { children }));
}

describe("chat startup and composer accessibility", () => {
  it.each(["en", "ko"] as const)("uses the shared Chat and Workspace labels for creation in %s", locale => {
    vi.mocked(useT).mockReturnValue(translator(locale));
    const html = render(createElement(NewChatEntry, { workspacesEnabled: true }));
    expect(html).toContain(">Chat<");
    expect(html).toContain(">Workspace<");
  });

  it.each(["en", "ko"] as const)("announces project loading without offering a premature send in %s", (locale) => {
    const t = translator(locale);
    vi.mocked(useT).mockReturnValue(t);
    const html = render(createElement(NewChatPanel));
    expect(html).toContain('role="status"');
    expect(html).toContain(t("common.loading"));
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(t("chat.noAgentProjects"));
    expect(html).not.toContain(`aria-label="${t("chat.send")}"`);
  });

  it.each(["en", "ko"] as const)("names the composer and exposes an explicit stop control during a run in %s", (locale) => {
    const t = translator(locale);
    vi.mocked(useT).mockReturnValue(t);
    const html = render(createElement(Composer, {
      onSend: vi.fn(),
      onStop: vi.fn(),
      disabled: true,
    }));
    expect(html).toMatch(new RegExp(`<textarea[^>]*aria-label="${t("chat.messageLabel")}"`));
    expect(html).toContain(`aria-label="${t("chat.stop")}"`);
    expect(html).not.toContain(`aria-label="${t("chat.send")}"`);
    expect(html).toContain(t("chat.inputHint"));
  });
});
