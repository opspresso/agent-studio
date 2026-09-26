import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { ViewerProvider } from "@/app/_lib/useViewer";
import { ModelRoutingEditor } from "@/app/agents/[name]/_components/ModelRoutingEditor";

describe("Agent routing opt-in", () => {
  it.each([true, false])("shows a single opt-in without exposing shared policy inputs: enabled=%s", (enabled) => {
    const markup = renderToStaticMarkup(createElement(MantineProvider, { children: createElement(ViewerProvider, { viewer: null,
      children: createElement(ModelRoutingEditor, { value: enabled, onChange: () => {} }),
    }) }));
    expect((markup.match(/type="checkbox"/g) ?? []).length).toBe(1);
    expect(markup).not.toContain('role="combobox"');
    expect(markup).not.toContain('type="number"');
    if (enabled) expect(markup).toContain("checked");
  });
});
