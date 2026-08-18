import { describe, expect, it } from "vitest";
import { costLimitsForSave } from "@/app/projects/[name]/settings/CostLimitsSection";

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
