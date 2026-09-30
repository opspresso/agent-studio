import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { McpAccountLookupEditor } from "@/app/tools/_components/McpAccountLookupEditor";
import { I18nProvider } from "@/app/_i18n/provider";
import type { McpAccountLookup } from "@/domain/mcp/account";

function render(value?: McpAccountLookup) {
  return renderToStaticMarkup(createElement(MantineProvider, { children: createElement(I18nProvider, {
    locale: "ko", children: createElement(McpAccountLookupEditor, { value, disabled: false, onSave: async () => {} }),
  }) }));
}

describe("account lookup editor", () => {
  it("offers automatic lookup without requiring a service-specific client app", () => {
    const markup = render();
    expect(markup).toContain("자동 (OIDC UserInfo 또는 제공자 기본값)");
    expect(markup).not.toContain("추가 계정 조회 권한");
  });
  it("shows the exact HTTP endpoint and account response field", () => {
    const markup = render({ kind: "http", endpoint: "https://new.example.test/me", labelPath: "/current/email" });
    expect(markup).toContain("https://new.example.test/me");
    expect(markup).toContain("/current/email");
    expect(markup).toContain("추가 계정 조회 권한");
  });
  it("shows the configured self tool and its read-only requirement", () => {
    const markup = render({ kind: "mcp", toolName: "who_am_i", arguments: { user: "self" }, labelPath: "/username" });
    expect(markup).toContain("who_am_i");
    expect(markup).toContain("self");
    expect(markup).toContain("readOnlyHint: true");
  });
});
