import { withConfigurations } from "./projectConfigurations";
import { describe, expect, it, vi } from "vitest";
import { openRun } from "@/application/run/runBracket";
import { assertModelsPriceable } from "@/application/run/modelPolicy";
import { assertWithinCostLimit } from "@/application/usage/costGuard";
import {
  toUnknownModelPolicy,
  type UnknownModelPolicy,
} from "@/domain/settings/modelPolicy";
import { prepareSubagent } from "@/application/execution/agentBindings";
import type { ExecutionDeps } from "@/application/execution/deps";
import { ValidationError } from "@/application/errors";
import { listModels } from "@/domain/llm/models";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";

/**
 * A model the registry does not carry still dispatches and is booked at $0, so
 * the one report that would reveal the spend is the one it corrupts. Allow stays
 * the default; a deployment whose usage rows become an invoice can refuse.
 */

const REGISTERED = listModels()[0]?.id ?? "openai/gpt-5-mini";
const UNKNOWN = "acme/not-in-the-registry";

const project: Project = {
  name: "p",
  displayName: "P",
  description: "",
  ownerEmail: "owner@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function configuration(overrides: Partial<AgentConfiguration> = {}): AgentConfiguration {
  return {
    projectName: "p",

    systemPrompt: "",

    model: REGISTERED,
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],

    ...overrides,
  };
}

const usage: UsageRepository = {
  record: async () => {},
  getDay: async () => null,
  claimAlert: async () => false,
  listActorsByProject: async () => [],
} as unknown as UsageRepository;

describe("toUnknownModelPolicy", () => {
  it("reads the two values, case- and space-insensitively", () => {
    expect(toUnknownModelPolicy("refuse")).toBe("refuse");
    expect(toUnknownModelPolicy("  REFUSE ")).toBe("refuse");
    expect(toUnknownModelPolicy("allow")).toBe("allow");
  });

  it("falls back to allow on anything else, including a typo", () => {
    // A malformed policy must not be the reason a deployment stops running —
    // the failure it guards against costs money slowly, and this one would
    // refuse every run at once.
    expect(toUnknownModelPolicy("refus")).toBe("allow");
    expect(toUnknownModelPolicy("")).toBe("allow");
    expect(toUnknownModelPolicy(undefined)).toBe("allow");
  });
});

describe("assertModelsPriceable", () => {
  it("refuses unselected models even when unknown pricing is allowed", () => {
    expect(() =>
      assertModelsPriceable("allow", { model: UNKNOWN, fallbackModel: UNKNOWN }),
    ).toThrow(ValidationError);
  });

  it("refuses an unregistered primary", () => {
    expect(() => assertModelsPriceable("refuse", { model: UNKNOWN })).toThrow(ValidationError);
  });

  it("refuses an unregistered fallback, which carries the whole run under load", () => {
    // The case that would otherwise leak only intermittently: the primary is
    // priced, and the unpriced path opens exactly when the primary is
    // rate-limited.
    expect(() =>
      assertModelsPriceable("refuse", { model: REGISTERED, fallbackModel: UNKNOWN }),
    ).toThrow(/selected by an administrator/);
  });

  it("names every offending id, not just the first", () => {
    try {
      assertModelsPriceable("refuse", { model: UNKNOWN, fallbackModel: "acme/other" });
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as Error).message).toContain(UNKNOWN);
      expect((error as Error).message).toContain("acme/other");
    }
  });

  it("passes a version whose models are both registered", () => {
    expect(() =>
      assertModelsPriceable("refuse", { model: REGISTERED, fallbackModel: REGISTERED }),
    ).not.toThrow();
  });
});

describe("the run bracket enforces it", () => {
  it("refuses before the cost guard is consulted", async () => {
    // The guard order is the point: a misconfigured version should not be told
    // it is over budget, and should not queue for a slot it would lose anyway.
    let costReads = 0;
    const counting: UsageRepository = {
      ...usage,
      getDay: async () => {
        costReads += 1;
        return null;
      },
    } as unknown as UsageRepository;
    const limitedProject = { ...project, costLimits: { blockThresholdUsd: 1 } };
    // Prove this budget fixture reads usage when the cost guard is reached.
    await assertWithinCostLimit({ usage: counting }, limitedProject, new Date("2026-09-21T00:00:00Z"));
    expect(costReads).toBe(1);
    costReads = 0;
    await expect(
      openRun(
        { usage: counting, unknownModelPolicy: async () => "refuse" },
        limitedProject,
        configuration({ model: UNKNOWN }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(costReads).toBe(0);
  });

  it("refuses an unselected model even when unpriced selected models are allowed", async () => {
    await expect(openRun({ usage, unknownModelPolicy: async () => "allow" }, project, configuration({ model: UNKNOWN })))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it("admits it when no policy is injected at all", async () => {
    // A deps bag assembled before this existed must behave exactly as it did.
    const bracket = await openRun({ usage }, project, configuration({ model: UNKNOWN }));

    expect(bracket.runId).toMatch(/[0-9a-f-]{36}/);
    await bracket.close();
  });

  /**
   * The read is a DynamoDB settings lookup, and the cost guard one line below it
   * fails open through the same outage — "a storage blip must not stop the
   * platform". Without a `try`, a blip fails the run
   * with a raw 500 while the guard beside it was deliberately letting runs
   * through.
   */
  it("allows the run when the policy itself cannot be read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const bracket = await openRun(
      {
        usage,
        unknownModelPolicy: async () => {
          throw new Error("dynamo down");
        },
      },
      project,
      configuration(),
    );

    expect(bracket.runId).toBeTruthy();
    expect(errors).toHaveBeenCalled();
    await bracket.close();
  });
});

describe("subagent preparation enforces model policy", () => {
  const child: Project = { ...project, name: "child" };
  const parent = configuration({ projectName: "parent", subagentList: [{ name: "child" }] });
  function prepare(policy: UnknownModelPolicy | undefined, model: string) {
    const deps = {
      projects: withConfigurations({ get: async () => child }, ({ get: async () => configuration({ projectName: "child", model }) }).get),
      ...(policy ? { unknownModelPolicy: async () => policy } : {}),
    } as unknown as ExecutionDeps;
    return prepareSubagent(deps, parent, "child", { message: "hi", images: [] }, async () => {}, { ancestry: ["parent"] });
  }
  it("refuses an unpriced child before model execution", async () => {
    await expect(prepare("refuse", UNKNOWN)).rejects.toThrow("selected by an administrator");
  });
  it("prepares a registered model", async () => {
    expect(await prepare("refuse", REGISTERED)).toMatchObject({ input: { model: REGISTERED } });
  });
  it("allows unpriced models when no refusal policy is configured", async () => {
    expect(await prepare(undefined, UNKNOWN)).toMatchObject({ input: { model: UNKNOWN } });
  });
});
