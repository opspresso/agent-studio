import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The boot path, executed rather than grepped.
 *
 * The audit guarantee used to rest on two `toContain` assertions over the source
 * text of `instrumentation.ts`, which a commented-out call or a branch that no
 * longer runs would satisfy just as well. Since `assertAuditSinkWired` proves
 * something narrow — that the push took, not that a duplicate module exists —
 * the part worth pinning is that `register()` actually reaches it and actually
 * refuses.
 *
 * Everything else the hook does is mocked away: the config guardrails, signal
 * handling, the model-catalog fetch, and the floating composition-root import
 * that reconciles managed MCP containers. What is left is the audit wiring in
 * its real order.
 */
const { state } = vi.hoisted(() => ({
  state: { repository: undefined as unknown },
}));

vi.mock("@/lib/config", () => ({
  assertRequiredConfig: () => {},
  assertAccessControlConfig: () => {},
  config: { modelsCatalogUrl: "https://models.test/models.json", modelsCatalogRefreshMs: 0 },
}));

// The catalog refresh is a network read that must not reach out of a unit
// test; a source that fails leaves the snapshot in place, which is the branch
// the boot takes offline anyway.
vi.mock("@/infrastructure/llm/modelCatalogHttpSource", () => ({
  createHttpModelCatalogSource: (url: string) => ({
    description: url,
    load: async () => {
      throw new Error("offline");
    },
  }),
}));

vi.mock("@/shared/lifecycle", () => ({
  registerShutdownSignals: () => {},
}));

vi.mock("@/infrastructure/db/repositories/auditRepository", () => ({
  get auditRepository() {
    return state.repository;
  },
}));

// Reached off the awaited path; undefined means "this deployment cannot start
// containers", which is the branch that does nothing.
vi.mock("@/lib/container", () => ({ managedMcpUseCases: undefined }));

const { register } = await import("@/instrumentation");
const { auditSink, setAuditSink } = await import("@/application/audit/recordAudit");

const sink = { append: async () => {}, listByDay: async () => [] };

beforeEach(() => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  setAuditSink(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setAuditSink(undefined);
});

describe("register", () => {
  it("wires the audit sink before the server accepts anything", async () => {
    state.repository = sink;
    await register();
    expect(auditSink()).toBe(sink);
  });

  it("refuses to boot when the push did not take", async () => {
    // An adapter export that failed to initialise. Without the assertion this
    // boots clean and records nothing for the life of the process.
    state.repository = undefined;
    await expect(register()).rejects.toThrow(/not wired/);
  });

  it("does nothing on the edge runtime, where the whole block folds away", async () => {
    // `instrumentation.ts` is compiled for both runtimes, and the Node-only
    // imports live inside the guard for exactly that reason.
    vi.stubEnv("NEXT_RUNTIME", "edge");
    state.repository = undefined;
    await expect(register()).resolves.toBeUndefined();
    expect(auditSink()).toBeUndefined();
  });
});
