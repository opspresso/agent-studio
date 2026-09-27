import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Execute register() to verify audit wiring and boot refusal. Other boot
 * dependencies are mocked to isolate the required audit wiring.
 */
const { state } = vi.hoisted(() => ({
  state: { repository: undefined as unknown },
}));

vi.mock("@/lib/config", () => ({
  assertRequiredConfig: () => {},
  assertAccessControlConfig: () => {},
  config: {},
}));

vi.mock("@/lib/runtime-settings", () => ({
  getLlmProviderConfigs: async () => [],
  startPublishedModelRefresh: () => {},
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
// The schema and the bootstrap administrator are a database's business; this
// test has none.
vi.mock("@/infrastructure/db/migrations", () => ({ migrate: async () => {} }));
vi.mock("@/lib/auth", () => ({ ensureBootstrapAdmin: async () => {} }));

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
