import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { ToolRow } from "@/app/_components/ToolRow";
import { theme } from "@/app/theme";

vi.mock("@/app/_i18n/provider", () => ({ useT: () => (key: string) => key }));

describe("tool result status", () => {
  it.each([
    ["Error: Repository or base branch is not configured for this project", "❌"],
    ['{"ready":true}', "✅"],
    [undefined, "…"],
  ])("renders %s as %s in stored and live tool rows", (content, marker) => {
    const html = renderToStaticMarkup(createElement(MantineProvider, { theme,
      children: createElement(ToolRow, { pair: { name: "Workspace", ...(content === undefined ? {} : { content }) } }),
    }));
    expect(html).toContain(marker);
    if (marker !== "✅") expect(html).not.toContain("✅");
  });
});
