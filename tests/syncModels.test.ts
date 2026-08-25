import { describe, expect, it } from "vitest";
import { parseArgs } from "../scripts/sync-models";

describe("sync-models arguments", () => {
  it("accepts check and a local catalog in either order", () => {
    expect(parseArgs(["--check", "--from", "catalog.json"])).toEqual({
      check: true,
      fromFile: "catalog.json",
    });
    expect(parseArgs(["--from", "catalog.json", "--check"])).toEqual({
      check: true,
      fromFile: "catalog.json",
    });
  });

  it("rejects --from without a file path", () => {
    expect(() => parseArgs(["--from"])).toThrow("--from expects a file path");
    expect(() => parseArgs(["--from", "--check"])).toThrow("--from expects a file path");
  });
});
