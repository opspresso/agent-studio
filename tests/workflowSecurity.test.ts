import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const WORKFLOWS = fileURLToPath(new URL("../.github/workflows", import.meta.url));

describe("workflow supply chain", () => {
  it("pins every external action to a full commit SHA", () => {
    const unpinned: string[] = [];
    for (const name of readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file))) {
      const lines = readFileSync(join(WORKFLOWS, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        const action = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line)?.[1];
        if (action && !action.startsWith("./") && !/@[0-9a-f]{40}$/.test(action)) {
          unpinned.push(`${name}:${index + 1} ${action}`);
        }
      });
    }

    expect(unpinned).toEqual([]);
  });
});
