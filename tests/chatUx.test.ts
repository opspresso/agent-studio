import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { NewChatPanel } from "@/app/chats/_components/NewChatPanel";
import { NewChatEntry } from "@/app/chats/_components/NewChatEntry";
import { ViewerProvider } from "@/app/_lib/useViewer";
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

function render(children: React.ReactNode, tier = "member") {
  return renderToStaticMarkup(createElement(MantineProvider, {
    children: createElement(ViewerProvider, { viewer: { email: "user@example.test", tier, isAdmin: false, isConfiguredAdmin: false }, children }),
  }));
}

describe("chat startup and composer accessibility", () => {
  it.each(["en", "ko"] as const)("uses the shared Chat and Workspace labels for creation in %s", locale => {
    vi.mocked(useT).mockReturnValue(translator(locale));
    const html = render(createElement(NewChatEntry, { workspacesEnabled: true }));
    expect(html).toContain(">Chat<");
    expect(html).toContain(">Workspace<");
  });

  it.each(["en", "ko"] as const)("announces agent loading without offering a premature send in %s", (locale) => {
    const t = translator(locale);
    vi.mocked(useT).mockReturnValue(t);
    const html = render(createElement(NewChatPanel));
    expect(html).toContain('role="status"');
    expect(html).toContain(t("common.loading"));
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(t("chat.noAgentSummarys"));
    expect(html).not.toContain(`aria-label="${t("chat.send")}"`);
  });

  it("keeps guest Chat and Workspace creation read-only", () => {
    const t = translator("ko");
    vi.mocked(useT).mockReturnValue(t);
    const html = render(createElement(NewChatEntry, { workspacesEnabled: true }), "guest");
    expect(html).toContain(t("common.memberExecutionRequired"));
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('role="radiogroup"');
  });

  it("keeps a downgraded caller's composer read-only while allowing stop", () => {
    const t = translator("en");
    vi.mocked(useT).mockReturnValue(t);
    const html = render(createElement(Composer, { onSend: vi.fn(), onStop: vi.fn(), disabled: true }), "guest");
    expect(html).toMatch(/<textarea[^>]*readOnly=""/i);
    expect(html).toContain(`aria-label="${t("chat.stop")}"`);
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
