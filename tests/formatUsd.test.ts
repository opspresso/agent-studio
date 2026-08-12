import { describe, expect, it } from "vitest";
import { formatUsd } from "@/app/_lib/formatUsd";
import { managedPortFor } from "@/infrastructure/mcp/managedPort";

/**
 * The same dashboard showed three formats: a chart widening to four decimals
 * under a cent, a total pinned at two, and per-row figures asking for four by
 * hand. The total read `$0.00` above rows that added to `$0.0043`.
 */
describe("formatUsd", () => {
  it("widens below a cent, which is where LLM costs live", () => {
    expect(formatUsd(0.0043)).toBe("$0.0043");
  });

  it("keeps two decimals for an ordinary amount", () => {
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(0.01)).toBe("$0.01");
  });

  it("does not widen zero into false precision", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("still takes an explicit width where a column wants one", () => {
    expect(formatUsd(12.5, 4)).toBe("$12.5000");
  });
});

/**
 * The two provisioners derived this identically, doc comment included. They do
 * not merely behave alike — they have to *agree*: a managed server provisioned
 * by one adapter is reached by name, so a different port would start a healthy
 * container that nothing can talk to, with no error anywhere.
 */
describe("managedPortFor", () => {
  it("is deterministic, so a restart re-derives the port it bound", () => {
    expect(managedPortFor("memory")).toBe(managedPortFor("memory"));
  });

  it("stays inside the range reserved for managed containers", () => {
    for (const name of ["memory", "notion", "slack", "a", "z".repeat(60)]) {
      const port = managedPortFor(name);
      expect(port).toBeGreaterThanOrEqual(3100);
      expect(port).toBeLessThan(3500);
    }
  });

  it("separates the names a deployment actually runs", () => {
    const names = ["memory", "notion", "slack", "document", "url-fetch"];
    expect(new Set(names.map(managedPortFor)).size).toBe(names.length);
  });
});
