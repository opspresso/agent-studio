import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authImportPhase } from "../scripts/import-dynamodb-export";

const source = readFileSync(
  new URL("../scripts/import-dynamodb-export.ts", import.meta.url),
  "utf8",
);

describe("DynamoDB export import ordering", () => {
  it("puts users ahead of sessions and accounts across page boundaries", () => {
    const pages = [
      [
        { PK: "AUTH#session#s1", SK: "META", userId: "u1" },
        { PK: "AUTH#account#a1", SK: "META", userId: "u1" },
      ],
      [{ PK: "AUTH#user#u1", SK: "META", id: "u1" }],
    ];
    const users = pages.flatMap((page) => page.filter((item) => authImportPhase(item) === "user"));
    const rest = pages.flatMap((page) => page.filter((item) => authImportPhase(item) === "rest"));

    expect([...users, ...rest].map((item) => item.PK)).toEqual([
      "AUTH#user#u1",
      "AUTH#session#s1",
      "AUTH#account#a1",
    ]);
  });

  it("wraps the complete multi-page import in one transaction", () => {
    expect(source.match(/await withTransaction\(/g)).toHaveLength(1);
    expect(source).toContain("The two file passes keep every user ahead");
  });
});
