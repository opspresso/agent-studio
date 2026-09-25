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

describe("cost limits from the loaded agent", () => {
  it("renders saved values without another agent request", () => {
    const html = renderToStaticMarkup(
      createElement(MantineProvider, {
        theme: {
          components: {
            AccordionPanel: { defaultProps: { keepMounted: true, keepMountedMode: "display-none" } },
          },
        },
        children: createElement(CostLimitsSection, {
          agentName: "agent",
          agent: { costLimits: { alertThresholdUsd: 4 } },
        }),
      }),
    );

    expect(html).toContain('value="4"');
    expect(html).not.toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain("Save cost limits");
  });
});
