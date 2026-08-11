import { describe, expect, it } from "vitest";
import { openRun } from "@/application/run/runBracket";
import { assertModelsPriceable } from "@/application/run/modelPolicy";
import {
  toUnknownModelPolicy,
  type UnknownModelPolicy,
} from "@/domain/settings/modelPolicy";
import { runLocalSubagent } from "@/application/execution/subagentRunner";
import type { ExecutionDeps } from "@/application/execution/deps";
import { ValidationError } from "@/application/errors";
import { MODEL_CONFIGS } from "@/domain/llm/models";
import type { RunOrigin } from "@/domain/execution/actor";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { UsageRepository } from "@/domain/usage/repository";

/**
 * A model the registry does not carry still dispatches and is booked at $0, so
 * the one report that would reveal the spend is the one it corrupts. Allow stays
 * the default; a deployment whose usage rows become an invoice can refuse.
 */

const REGISTERED = MODEL_CONFIGS[0]?.id ?? "openai/gpt-5-mini";
const UNKNOWN = "acme/not-in-the-registry";

const project: Project = {
  name: "p",
  displayName: "P",
  description: "",
  projectType: "agent",
  ownerEmail: "owner@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function version(overrides: Partial<Version> = {}): Version {
  return {
    projectName: "p",
    versionName: "v1",
    systemPrompt: "",
    userPromptTemplate: "",
    model: REGISTERED,
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00Z",
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
  it("allows anything under the default policy", () => {
    expect(() =>
      assertModelsPriceable("allow", { model: UNKNOWN, fallbackModel: UNKNOWN }),
    ).not.toThrow();
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
    ).toThrow(/not in the registry/);
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
    await expect(
      openRun(
        { usage: counting, unknownModelPolicy: async () => "refuse" },
        project,
        version({ model: UNKNOWN }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(costReads).toBe(0);
  });

  it("admits the same run when the policy is allow", async () => {
    const bracket = await openRun(
      { usage, unknownModelPolicy: async () => "allow" },
      project,
      version({ model: UNKNOWN }),
    );
    await bracket.close();
  });

  it("admits it when no policy is injected at all", async () => {
    // A deps bag assembled before this existed must behave exactly as it did.
    const bracket = await openRun({ usage }, project, version({ model: UNKNOWN }));
    await bracket.close();
  });
});

describe("a subagent transfer enforces it too", () => {
  /**
   * The bracket is not the whole set of paths that spend money. A transfer never
   * opens one — by design — yet it dispatches to the provider and books a usage
   * row exactly as its parent does, and the parent's model being registered says
   * nothing about the child's.
   */
  const child: Project = { ...project, name: "child", publishedVersion: "v1" };

  function deps(policy: UnknownModelPolicy | undefined, model: string): ExecutionDeps {
    return {
      projects: { get: async () => child },
      versions: { get: async () => version({ projectName: "child", model }) },
      ...(policy ? { unknownModelPolicy: async () => policy } : {}),
    } as unknown as ExecutionDeps;
  }

  async function collect(source: AsyncGenerator<EngineChunk, string>) {
    const chunks: EngineChunk[] = [];
    let step = await source.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await source.next();
    }
    return { chunks, text: step.value };
  }

  const noUsage = async () => {};
  const origin = { actor: { kind: "user", id: "u@example.com" } } as unknown as RunOrigin;

  it("refuses an unpriced child before it reaches the channel", async () => {
    const { chunks, text } = await collect(
      runLocalSubagent(deps("refuse", UNKNOWN), "child", "hi", 1, 4, noUsage, origin),
    );
    expect(text).toBe("");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.author).toBe("child");
    expect(chunks[0]?.error).toContain("not in the registry");
  });

  it("runs a child whose model the registry can price", async () => {
    // Reaching the dispatch is the assertion: these deps carry no channel, so
    // what comes back is the channel failing rather than the policy refusing.
    const { chunks } = await collect(
      runLocalSubagent(deps("refuse", REGISTERED), "child", "hi", 1, 4, noUsage, origin),
    );
    expect(chunks[0]?.error).not.toContain("not in the registry");
  });

  it("leaves a transfer alone when no policy is injected", async () => {
    // A deps bag assembled before this existed behaves exactly as it did.
    const { chunks } = await collect(
      runLocalSubagent(deps(undefined, UNKNOWN), "child", "hi", 1, 4, noUsage, origin),
    );
    expect(chunks[0]?.error).not.toContain("not in the registry");
  });
});
