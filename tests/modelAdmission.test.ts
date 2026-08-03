import { describe, expect, it } from "vitest";
import {
  UnknownModelError,
  assertModelsRunnable,
  type ModelAdmissionDeps,
} from "@/application/execution/modelAdmission";
import { openRun } from "@/application/execution/runBracket";
import type { Project } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";

/** In the registry. If this id is ever retired the test says so rather than drifting. */
const KNOWN = "openai/gpt-5-mini";
const UNKNOWN = "acme/does-not-exist";

const refuse: ModelAdmissionDeps = { unknownModelPolicy: async () => "refuse" };
const allow: ModelAdmissionDeps = { unknownModelPolicy: async () => "allow" };

describe("assertModelsRunnable", () => {
  it("refuses an unregistered primary model", async () => {
    await expect(assertModelsRunnable(refuse, { model: UNKNOWN })).rejects.toBeInstanceOf(
      UnknownModelError,
    );
  });

  it("refuses an unregistered fallback, which is reached at the worst moment", async () => {
    // The fallback serves a retry of a failed primary — discovering there that
    // the run cannot be priced is discovering it mid-incident.
    await expect(
      assertModelsRunnable(refuse, { model: KNOWN, fallbackModel: UNKNOWN }),
    ).rejects.toBeInstanceOf(UnknownModelError);
  });

  it("names every unregistered model, so one fix does not reveal the next", async () => {
    const error = await assertModelsRunnable(refuse, {
      model: UNKNOWN,
      fallbackModel: "acme/other",
    }).then(
      () => null,
      (caught: unknown) => caught as UnknownModelError,
    );
    expect(error?.modelIds).toEqual([UNKNOWN, "acme/other"]);
  });

  it("admits a run whose models are all registered", async () => {
    await expect(
      assertModelsRunnable(refuse, { model: KNOWN, fallbackModel: KNOWN }),
    ).resolves.toBeUndefined();
  });

  it("admits everything under the default policy", async () => {
    await expect(assertModelsRunnable(allow, { model: UNKNOWN })).resolves.toBeUndefined();
  });

  it("admits everything when no policy is wired at all", async () => {
    // The path every deployment had before this existed: no reader, no lookup.
    await expect(assertModelsRunnable({}, { model: UNKNOWN })).resolves.toBeUndefined();
  });

  it("fails open when the policy cannot be read", async () => {
    // The guard protects a billing figure; a settings blip must not become a
    // platform outage.
    const broken: ModelAdmissionDeps = {
      unknownModelPolicy: async () => {
        throw new Error("settings store unavailable");
      },
    };
    await expect(assertModelsRunnable(broken, { model: UNKNOWN })).resolves.toBeUndefined();
  });
});

describe("openRun", () => {
  const project: Project = {
    name: "p",
    displayName: "P",
    description: "",
    projectType: "agent",
    ownerEmail: "owner@x.com",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  /** Counts the reads the cost guard would make; none should happen on a refusal. */
  function usageRepo() {
    let reads = 0;
    const usage = {
      getDaily: async () => {
        reads += 1;
        return null;
      },
      addUsage: async () => {},
      claimCostNotice: async () => true,
    } as unknown as UsageRepository;
    return { usage, reads: () => reads };
  }

  it("refuses an unregistered model before the cost guard reads anything", async () => {
    const { usage, reads } = usageRepo();
    await expect(
      openRun(
        { usage, unknownModelPolicy: async () => "refuse" },
        { ...project, costLimits: { blockThresholdUsd: 10 } },
        undefined,
        { model: UNKNOWN },
      ),
    ).rejects.toBeInstanceOf(UnknownModelError);
    expect(reads()).toBe(0);
  });

  it("admits a registered model exactly as before", async () => {
    const { usage } = usageRepo();
    const bracket = await openRun(
      { usage, unknownModelPolicy: async () => "refuse" },
      project,
      undefined,
      { model: KNOWN },
    );
    await bracket.close();
  });
});
