import { describe, expect, it } from "vitest";
import { parseJsonObject } from "@/app/projects/[name]/_components/VersionEditor";

describe("parseJsonObject", () => {
  it("accepts only JSON objects", () => {
    expect(parseJsonObject('{"type":"object"}')).toEqual({ type: "object" });
    expect(parseJsonObject("{}")).toEqual({});
  });

  it.each(["[]", '"schema"', "42", "null", "{broken"])("rejects %s", (text) => {
    expect(parseJsonObject(text)).toBeNull();
  });
});
