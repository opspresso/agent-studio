import { describe, expect, it } from "vitest";
import { activeTabHref } from "@/app/_components/PageTabs";

describe("route-backed page tabs", () => {
  const tabs = [{ href: "/projects/example" }, { href: "/projects/example/traces" }, { href: "/projects/example/settings" }];
  it("keeps the trace tab active on a nested trace detail", () => {
    expect(activeTabHref("/projects/example/traces/trace-1", tabs)).toBe("/projects/example/traces");
    expect(activeTabHref("/projects/example", tabs)).toBe("/projects/example");
  });
  it("does not confuse path prefixes with segments", () => {
    expect(activeTabHref("/projects/example-two/traces", tabs)).toBeNull();
  });
});
