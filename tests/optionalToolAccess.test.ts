import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import { optionalToolAccessible } from "@/application/execution/optionalToolAccess";

describe("optional execution tool access", () => {
  it("omits a tool for a known authorization or configuration refusal", async () => {
    for (const refusal of [
      new ForbiddenError("private project"),
      new NotFoundError("project removed"),
      new ValidationError("tool disabled"),
    ]) {
      expect(await optionalToolAccessible(async () => { throw refusal; })).toBe(false);
    }
    expect(await optionalToolAccessible(async () => {})).toBe(true);
  });

  it("propagates a failed authorization read instead of hiding a configured tool", async () => {
    const outage = new Error("member store unavailable");
    await expect(optionalToolAccessible(async () => { throw outage; })).rejects.toBe(outage);
  });
});
