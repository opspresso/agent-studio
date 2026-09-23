import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { CostLimitsSection, costLimitsForSave } from "@/app/agents/[name]/settings/CostLimitsSection";

describe("costLimitsForSave", () => {
  it("keeps notification destinations before a threshold is configured", () => {
    expect(
      costLimitsForSave({
        alertDestinations: [{ kind: "slack", channelId: "C1" }],
      }),
    ).toEqual({
      alertDestinations: [{ kind: "slack", channelId: "C1" }],
    });
  });

  it("clears cost limits only when thresholds and destinations are both empty", () => {
    expect(costLimitsForSave({})).toBeNull();
  });
});

describe("cost limits before a successful read", () => {
  it("renders the editor inside a disabled fieldset", () => {
    const html = renderToStaticMarkup(
      createElement(MantineProvider, {
        theme: {
          components: {
            AccordionPanel: { defaultProps: { keepMounted: true, keepMountedMode: "display-none" } },
          },
        },
        children: createElement(CostLimitsSection, { projectName: "project" }),
      }),
    );

    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain("Save cost limits");
  });
});
