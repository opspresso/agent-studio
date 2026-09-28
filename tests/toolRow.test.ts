import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { ToolRow } from "@/app/_components/ToolRow";
import { theme } from "@/app/theme";

vi.mock("@/app/_i18n/provider", () => ({ useT: () => (key: string) => key }));

describe("tool result status", () => {
  it.each([
    ["Error: Repository or base branch is not configured for this agent", "failed"],
    ['{"ready":true}', "completed"],
    [undefined, "running"],
  ])("renders %s as %s in stored and live tool rows", (content, status) => {
    const html = renderToStaticMarkup(createElement(MantineProvider, { theme,
      children: createElement(ToolRow, { pair: { name: "Workspace", ...(content === undefined ? {} : { content }) } }),
    }));
    expect(html).toContain(`role="img" aria-label="tool.status.${status}"`);
    if (status !== "completed") expect(html).not.toContain('aria-label="tool.status.completed"');
  });
});
