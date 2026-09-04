import { describe, expect, it } from "vitest";
import {
  createManagedMcpSchema,
  updateManagedMcpSchema,
} from "@/app/api/mcps/managed/_schema";

describe("managed MCP request schemas", () => {
  it("requires the create identity and workload fields", () => {
    expect(
      createManagedMcpSchema.safeParse({
        name: "memory",
        image: "ghcr.io/opspresso/mcp-memory:1.0",
        containerPort: 8080,
      }).success,
    ).toBe(true);
    expect(createManagedMcpSchema.safeParse({ name: "memory" }).success).toBe(false);
  });

  it("derives a partial update contract from the create workload", () => {
    expect(
      updateManagedMcpSchema.safeParse({ image: "ghcr.io/opspresso/mcp-memory:2.0" }).success,
    ).toBe(true);
    expect(updateManagedMcpSchema.safeParse({ description: "new description" }).success).toBe(
      true,
    );
  });

  it.each([
    ["image", { image: "repo/image:latest;--privileged" }],
    ["env file", { envRefs: ["relative.env"] }],
    ["reserved port", { environment: { PORT: "9000" } }],
    ["multiline environment", { environment: { TOKEN: "first\nsecond" } }],
    ["control argument", { args: ["ok\nbad"] }],
    ["endpoint URL", { endpointPath: "https://example.com/mcp" }],
  ])("rejects an unsafe %s value before provisioning", (_label, update) => {
    expect(updateManagedMcpSchema.safeParse(update).success).toBe(false);
  });
});
