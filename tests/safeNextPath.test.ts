import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/shared/safeNextPath";

describe("safeNextPath", () => {
  it("keeps a path, its query and its fragment", () => {
    expect(safeNextPath("/projects")).toBe("/projects");
    expect(safeNextPath("/projects/my-bot/usage?from=2026-01-01")).toBe(
      "/projects/my-bot/usage?from=2026-01-01",
    );
    expect(safeNextPath("/chats#latest")).toBe("/chats#latest");
  });

  it("falls back when there is nothing usable", () => {
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("/projects", "/dashboard")).toBe("/projects");
    expect(safeNextPath("", "/dashboard")).toBe("/dashboard");
  });

  it("refuses anything that leaves this origin", () => {
    // The absolute forms are the obvious ones.
    expect(safeNextPath("https://evil.example/steal")).toBe("/");
    expect(safeNextPath("http://evil.example")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
    // These two start with "/" and are still off-origin: a browser reads them
    // as protocol-relative URLs, so a bare startsWith("/") check lets them out.
    expect(safeNextPath("//evil.example/steal")).toBe("/");
    expect(safeNextPath("/\\evil.example/steal")).toBe("/");
  });

  it("refuses control characters that could split the redirect header", () => {
    expect(safeNextPath("/projects\r\nSet-Cookie: a=b")).toBe("/");
    expect(safeNextPath("/projects\n")).toBe("/");
    expect(safeNextPath("/projects\u0000")).toBe("/");
  });
});
