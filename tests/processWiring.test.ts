import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(async () => {
  vi.resetModules();
  const { setAuditSink } = await import("@/application/audit/recordAudit");
  setAuditSink(undefined);
});

describe("process-wide application wiring", () => {
  it("keeps the audit sink across duplicate module evaluations", async () => {
    const first = await import("@/application/audit/recordAudit");
    const sink = { append: async () => {}, listByDay: async () => [] };
    first.setAuditSink(sink);

    vi.resetModules();
    const second = await import("@/application/audit/recordAudit");

    expect(second.auditSink()).toBe(sink);
    expect(() => second.assertAuditSinkWired()).not.toThrow();
  });

  it("keeps managed MCP lifecycle claims across duplicate module evaluations", async () => {
    const first = await import("@/application/mcp/managedMcpUseCases");
    const claims = first.processManagedMcpLifecycleClaims();
    claims.add("shared-container");
    try {
      vi.resetModules();
      const second = await import("@/application/mcp/managedMcpUseCases");

      expect(second.processManagedMcpLifecycleClaims()).toBe(claims);
      expect(second.processManagedMcpLifecycleClaims().has("shared-container")).toBe(true);
    } finally {
      claims.delete("shared-container");
    }
  });
});
