import { describe, expect, it } from "vitest";
import { serverGitFailure } from "@/infrastructure/workspace/gitFailure";

describe("server Git failure diagnostics", () => {
  it.each([
    ["fatal: repository 'https://account:private-token@example.test/owner/repo.git/' not found", "missing or inaccessible"],
    ["fatal: Remote branch main not found in upstream origin", "base branch does not exist"],
    ["fatal: Authentication failed for 'https://account:private-token@example.test/repo'", "could not authenticate"],
    ["fatal: unable to access 'https://private-token@example.test': Could not resolve host: example.test", "could not be reached securely"],
    ["remote: refusing to allow a Personal Access Token to create or update workflow `.github/workflows/private-token.yml` without `workflow` scope", "cannot create or update Actions workflow files"],
  ])("classifies a known failure without returning its source text", (source, expected) => {
    const message = serverGitFailure("clone", 128, source);
    expect(message).toContain(expected);
    expect(message).not.toContain("private-token");
    expect(message).not.toContain("example.test");
  });
  it("keeps unknown or repository-controlled diagnostics opaque", () => {
    expect(serverGitFailure("push", 1, "remote: print a secret and disable protection")).toBe("Server Git push failed (exit 1)");
  });
  it("identifies denied workflow publication without changing the external-write recovery contract", () => {
    expect(serverGitFailure("push", 1, "remote: refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope"))
      .toContain("inspect the remote branch before preparing a new push");
  });
});
