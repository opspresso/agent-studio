import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import ProjectLayout from "@/app/agents/[name]/layout";
import { translator } from "@/app/_i18n/translate";

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "code-agent" }),
  usePathname: () => "/agents/code-agent/settings",
}));
vi.mock("@/app/_i18n/provider", () => ({ useT: () => translator("en") }));
vi.mock("@/app/_lib/useViewer", () => ({ useViewer: () => null, canEditProject: () => false }));

describe("Agent layout", () => {
  it("does not show project-dependent tabs or content before the project loads", () => {
    const html = renderToStaticMarkup(createElement(MantineProvider, {
      children: createElement(ProjectLayout, {
        children: createElement("div", null, "Agent content"),
      }),
    }));

    expect(html).toContain(translator("en")("common.loading"));
    expect(html).not.toContain("Agent content");
    expect(html).not.toContain('role="tablist"');
  });
});
