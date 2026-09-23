import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(async () => {
  vi.resetModules();
  const [{ setAuditSink }, { setAdminCheck }] = await Promise.all([
    import("@/application/audit/recordAudit"),
    import("@/application/project/projectUseCases"),
  ]);
  setAuditSink(undefined);
  setAdminCheck(async () => false);
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

  it("keeps the configured admin check across duplicate module evaluations", async () => {
    const first = await import("@/application/project/projectUseCases");
    first.setAdminCheck(async (email) => email === "admin@example.com");

    vi.resetModules();
    const second = await import("@/application/project/projectUseCases");
    const project = {
      name: "private-project",
      displayName: "Private project",
      description: "",
      visibility: "private" as const,
      memberEmails: [],
      ownerEmail: "owner@example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await expect(second.userMayAccessProject(project, "admin@example.com")).resolves.toBe(true);
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
