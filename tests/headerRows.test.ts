import { describe, expect, it } from "vitest";
import { rowsToRecord } from "@/app/_components/HeaderRows";
import { mcpBindingSchema } from "@/app/api/agents/_lib/schemas";
import { createManagedMcpSchema } from "@/app/api/mcps/managed/_schema";

describe("header row request encoding", () => {
  it("preserves a prototype-named header in the request body", () => {
    const headers = rowsToRecord([{ key: "__proto__", value: "secret" }]);
    expect(Object.hasOwn(headers, "__proto__")).toBe(true);
    expect(JSON.stringify(headers)).toBe('{"__proto__":"secret"}');
  });
  it.each(["secret", null])("preserves a prototype-named Agent override through API validation (%s)", value => {
    const body = JSON.parse(JSON.stringify({ name: "server", headers: { ["__proto__"]: value } }));
    const parsed = mcpBindingSchema.parse(body);
    expect(Object.hasOwn(parsed.headers!, "__proto__")).toBe(true);
    expect(parsed.headers!["__proto__"]).toBe(value);
  });
  it("preserves managed MCP headers while validating the workload", () => {
    const parsed = createManagedMcpSchema.parse({ name: "server", image: "example/mcp:1", containerPort: 8000,
      headers: JSON.parse('{"__proto__":"secret"}') });
    expect(parsed.headers!["__proto__"]).toBe("secret");
  });
  it.each([[["Header", "value"]], null, { Header: 1 }, { Header: false }])("rejects malformed header records (%j)", headers => {
    expect(mcpBindingSchema.safeParse({ name: "server", headers }).success).toBe(false);
  });
});
