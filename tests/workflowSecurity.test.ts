import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const WORKFLOWS = fileURLToPath(new URL("../.github/workflows", import.meta.url));
const AWS_ROLES = fileURLToPath(new URL("../.github/aws-role", import.meta.url));

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

  it("keeps arbitrary branch pushes off persistent self-hosted runners", () => {
    const text = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
    expect(text).toMatch(/branches:\s*\["\*\*"\]/);
    expect(usesSelfHostedRunner(text)).toBe(false);
  });

  it("recognizes every supported self-hosted runner spelling", () => {
    expect(usesSelfHostedRunner("jobs:\n  test:\n    runs-on: self-hosted")).toBe(true);
    expect(usesSelfHostedRunner("jobs:\n  test:\n    runs-on: [self-hosted, linux]")).toBe(true);
    expect(usesSelfHostedRunner("jobs:\n  test:\n    runs-on:\n      - self-hosted\n      - linux")).toBe(true);
    expect(usesSelfHostedRunner("jobs:\n  test:\n    runs-on: ubuntu-latest")).toBe(false);
  });

  it("does not expose privileged self-hosted workflows to arbitrary-ref dispatch", () => {
    for (const name of ["check-models.yml", "release.yml"]) {
      const text = readFileSync(join(WORKFLOWS, name), "utf8");
      expect(text, name).not.toMatch(/^\s{2}workflow_dispatch\s*:/m);
    }
  });

  it("gates every release job on a version tag", () => {
    const text = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
    const jobBlocks = text.split(/^  (?=[a-z][a-z-]+:\s*$)/m).slice(1);
    const selfHosted = jobBlocks.filter(usesSelfHostedRunner);
    const unguarded = selfHosted
      .filter((block) => !/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(block));

    expect(selfHosted.length).toBeGreaterThan(0);
    expect(unguarded).toEqual([]);
  });

  it("scopes AWS roles to their exact workflow and refs", () => {
    const release = JSON.parse(readFileSync(join(AWS_ROLES, "trust-policy.json"), "utf8"));
    const models = JSON.parse(readFileSync(join(AWS_ROLES, "models-trust-policy.json"), "utf8"));

    expect(release.Statement[0].Condition).toEqual({
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:workflow": "Release",
      },
      StringLike: {
        "token.actions.githubusercontent.com:sub":
          "repo:opspresso/agent-studio:ref:refs/tags/v*",
      },
    });
    expect(models.Statement[0].Condition).toEqual({
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub":
          "repo:opspresso/agent-studio:ref:refs/heads/main",
        "token.actions.githubusercontent.com:workflow": "Check models",
      },
    });
  });

  it("grants the release role only the ECR image-push actions", () => {
    const policy = JSON.parse(readFileSync(join(AWS_ROLES, "role-policy.json"), "utf8"));
    const repositoryStatement = policy.Statement.find(
      (statement: { Resource: string }) => statement.Resource !== "*",
    );

    expect(repositoryStatement).toEqual({
      Effect: "Allow",
      Action: [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:CompleteLayerUpload",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart",
      ],
      Resource: "arn:aws:ecr:ap-northeast-2:396608815058:repository/agent-studio",
    });
  });

  it("grants the model-check role only catalog listing", () => {
    const policy = JSON.parse(
      readFileSync(join(AWS_ROLES, "models-role-policy.json"), "utf8"),
    );

    expect(policy.Statement).toEqual([
      {
        Effect: "Allow",
        Action: ["bedrock-mantle:ListModels"],
        Resource: "*",
      },
    ]);
  });
});
