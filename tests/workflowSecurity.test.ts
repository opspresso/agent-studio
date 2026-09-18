import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const WORKFLOWS = fileURLToPath(new URL("../.github/workflows", import.meta.url));

function usesSelfHostedRunner(text: string): boolean {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)runs-on:\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    if (/\bself-hosted\b/.test(match[2] ?? "")) {
      return true;
    }
    const indent = match[1]?.length ?? 0;
    for (const child of lines.slice(index + 1)) {
      const childIndent = /^\s*/.exec(child)?.[0].length ?? 0;
      if (child.trim() && childIndent <= indent) {
        break;
      }
      if (/^\s*-\s*self-hosted\s*$/.test(child)) {
        return true;
      }
    }
  }
  return false;
}

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

  it("never runs pull-request code on a persistent self-hosted runner", () => {
    const unsafe: string[] = [];
    for (const name of readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file))) {
      const text = readFileSync(join(WORKFLOWS, name), "utf8");
      if (/^\s{2}pull_request\s*:/m.test(text) && usesSelfHostedRunner(text)) {
        unsafe.push(name);
      }
    }

    expect(unsafe).toEqual([]);
  });

  it("runs branch pushes on the cost-controlled self-hosted runner", () => {
    const text = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
    expect(text).toMatch(/branches:\s*\["\*\*"\]/);
    expect(usesSelfHostedRunner(text)).toBe(true);
  });

  it("does not expose privileged workflows to arbitrary-ref dispatch", () => {
    for (const name of ["check-models.yml", "release.yml"]) {
      const text = readFileSync(join(WORKFLOWS, name), "utf8");
      expect(text, name).not.toMatch(/^\s{2}workflow_dispatch\s*:/m);
    }
  });

  it("gates every release job on a version tag", () => {
    const text = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
    const jobs = text.split(/^jobs:\s*$/m)[1] ?? "";
    const jobBlocks = jobs.split(/^  (?=[a-z][a-z-]+:\s*$)/m).slice(1);
    const unguarded = jobBlocks
      .filter((block) => !/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(block));

    expect(jobBlocks.length).toBeGreaterThan(0);
    expect(unguarded).toEqual([]);
  });

});
