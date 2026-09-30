import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { McpConnectionIdentity } from "@/app/agents/[name]/_components/McpConnectionCard";
import { I18nProvider } from "@/app/_i18n/provider";
import type { McpConnectionView } from "@/app/agents/lib/api";

const connection: McpConnectionView = {
  serverName: "github", clientId: "app", clientRegistered: false, status: "connected",
  scopes: ["repo"], connectedBy: "studio-user@example.test", connectedAt: "2026-09-30T03:00:00.000Z",
};

function render(overrides: Partial<McpConnectionView>, locale: "en" | "ko" = "ko") {
  return renderToStaticMarkup(createElement(MantineProvider, {
    children: createElement(I18nProvider, { locale, children: createElement(McpConnectionIdentity, {
      connection: { ...connection, ...overrides },
    }) }),
  }));
}

describe("Agent MCP connection account display", () => {
  it.each([
    { provider: "github" as const, label: "octocat" },
    { provider: "google" as const, label: "connected@example.test" },
  ])("shows the actual $provider account instead of the Studio account", (connectedAccount) => {
    const html = render({ connectedAccount });
    expect(html).toContain(`${connectedAccount.label} 계정에 연결됨`);
    expect(html).not.toContain(connection.connectedBy);
    expect(html).toContain("repo");
  });

  it("explicitly shows an unknown identity without substituting the Studio user's email", () => {
    const html = render({});
    expect(html).toContain("연결된 계정을 확인할 수 없습니다.");
    expect(html).not.toContain(connection.connectedBy);
  });

  it("renders the English account label and escapes provider-controlled markup", () => {
    const html = render({ connectedAccount: { provider: "github", label: "<script>account</script>" } }, "en");
    expect(html).toContain("Connected as &lt;script&gt;account&lt;/script&gt;");
    expect(html).not.toContain("<script>account</script>");
  });
});
