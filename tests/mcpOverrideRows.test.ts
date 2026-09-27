import { describe, expect, it } from "vitest";
import {
  overridesToRows,
  rowsToOverrides,
} from "@/app/agents/[name]/_components/mcpOverrides";

describe("MCP override row encoding", () => {
  it("shows a null marker as a removal row with no value", () => {
    expect(overridesToRows({ Authorization: "Bearer x", "X-Gone": null })).toEqual([
      { key: "Authorization", value: "Bearer x", storedValue: "Bearer x", remove: false },
      { key: "X-Gone", value: "", remove: true },
    ]);
  });

  it("treats an absent override map as no rows", () => {
    expect(overridesToRows(undefined)).toEqual([]);
  });

  it("encodes a removal row back as null, not as an empty header", () => {
    // The distinction matters: "" means "keep the stored secret", null means
    // "drop the registry default".
    expect(rowsToOverrides([{ key: "X-Gone", value: "", remove: true }])).toEqual({
      "X-Gone": null,
    });
  });

  it("keeps an empty value when the row is not a removal", () => {
    expect(rowsToOverrides([{ key: "Authorization", value: "", remove: false }])).toEqual({
      Authorization: "",
    });
  });

  it("preserves a prototype-named override in the request body", () => {
    const headers = rowsToOverrides([{ key: "__proto__", value: "", remove: true }]);
    expect(headers && Object.hasOwn(headers, "__proto__")).toBe(true);
    expect(JSON.stringify(headers)).toBe('{"__proto__":null}');
  });

  it("drops half-typed rows with a blank header name", () => {
    expect(
      rowsToOverrides([
        { key: "  ", value: "orphan", remove: false },
        { key: " X-Trimmed ", value: "v", remove: false },
      ]),
    ).toEqual({ "X-Trimmed": "v" });
  });

  it("returns undefined when nothing is left, so the binding stores no headers field", () => {
    expect(rowsToOverrides([])).toBeUndefined();
    expect(rowsToOverrides([{ key: "", value: "x", remove: false }])).toBeUndefined();
  });

  it("round-trips an override map unchanged", () => {
    const headers = { Authorization: "Bearer x", "X-Tenant": "acme", "X-Gone": null };
    expect(rowsToOverrides(overridesToRows(headers))).toEqual(headers);
  });

  it("does NOT round-trip a row whose header name is still blank", () => {
    // The editor owns draft rows: blank names have no saved-map representation.
    const rows = [
      { key: "Authorization", value: "Bearer x", remove: false },
      { key: "", value: "", remove: false },
    ];

    const projected = rowsToOverrides(rows);

    expect(projected).toEqual({ Authorization: "Bearer x" });
    expect(overridesToRows(projected)).toHaveLength(1);
    expect(overridesToRows(projected)).not.toEqual(rows);
  });
});
