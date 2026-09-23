import { describe, expect, it } from "vitest";
import { activeTabHref } from "@/app/_components/PageTabs";

describe("route-backed page tabs", () => {
  const tabs = [{ href: "/agents/example" }, { href: "/agents/example/traces" }, { href: "/agents/example/settings" }];
  it("keeps the trace tab active on a nested trace detail", () => {
    expect(activeTabHref("/agents/example/traces/trace-1", tabs)).toBe("/agents/example/traces");
    expect(activeTabHref("/agents/example", tabs)).toBe("/agents/example");
  });
  it("does not confuse path prefixes with segments", () => {
    expect(activeTabHref("/agents/example-two/traces", tabs)).toBeNull();
  });
});
