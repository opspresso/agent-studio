import { describe, expect, it } from "vitest";
import { rowsToRecord } from "@/app/_components/HeaderRows";

describe("header row request encoding", () => {
  it("preserves a prototype-named header in the request body", () => {
    const headers = rowsToRecord([{ key: "__proto__", value: "secret" }]);
    expect(Object.hasOwn(headers, "__proto__")).toBe(true);
    expect(JSON.stringify(headers)).toBe('{"__proto__":"secret"}');
  });
});
