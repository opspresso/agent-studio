import { describe, expect, it } from "vitest";
import { parseKeyValueList } from "@/shared/parseList";

describe("parseKeyValueList", () => {
  it("preserves case — the values are credentials", () => {
    expect(parseKeyValueList("Authorization=Bearer sk-AbC123XyZ")).toEqual({
      Authorization: "Bearer sk-AbC123XyZ",
    });
  });

  it("keeps every `=` after the first, as in base64 padding", () => {
    expect(parseKeyValueList("Authorization=Basic dXNlcjpwYXNz==")).toEqual({
      Authorization: "Basic dXNlcjpwYXNz==",
    });
  });

  it("splits on commas and trims around the pair", () => {
    expect(parseKeyValueList(" a=1 , x-team=Two ")).toEqual({ a: "1", "x-team": "Two" });
  });

  it("drops entries with no `=`, an empty key or an empty value", () => {
    expect(parseKeyValueList("noequals,=orphan,empty=,ok=yes,")).toEqual({ ok: "yes" });
  });

  it("returns an empty record for an empty string", () => {
    expect(parseKeyValueList("")).toEqual({});
  });
});
