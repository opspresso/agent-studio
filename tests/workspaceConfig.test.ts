import { describe, expect, it } from "vitest";
import { parseWorkspaceConfig } from "@/lib/workspaceConfig";

describe("Workspace deployment configuration", () => {
  it("keeps model credentials in registered channels and bounds worker concurrency", () => {
    const input = { image: "workspace:local", projects: [{ projectName: "demo", runtimes: ["codex"], repositories: ["org/first", "org/second"] }], workerConcurrency: 1, runtimes: { codex: { provider: "openai", model: "model-id" } } };
    const configured = parseWorkspaceConfig(JSON.stringify(input));
    expect(configured?.runtimes.codex?.provider).toBe("openai");
    expect(configured?.runtimes.codex?.environment).toBeUndefined();
    expect(configured?.workerConcurrency).toBe(1);
    expect(() => parseWorkspaceConfig(JSON.stringify({ ...input, workerConcurrency: 0 }))).toThrow();
  });
  it("stays disabled without configuration", () => {
    expect(parseWorkspaceConfig(undefined)).toBeUndefined();
    expect(parseWorkspaceConfig(" ")).toBeUndefined();
  });
  it("supports general work and explicitly configured agent model credentials", () => {
    const config = parseWorkspaceConfig(JSON.stringify({ image: "workspace:local",
      projects: [{ projectName: "general", runtimes: ["command", "codex"] }],
      runtimes: { codex: { model: "model-id", environment: { OPENAI_API_KEY: "test-model-key" } } } }));
    expect(config?.projects[0]?.repository).toBeUndefined();
    expect(config?.network).toBe("none");
    expect(config?.projects[0]?.agentTools).toBe(false);
    expect(config?.runtimes.codex?.environment?.OPENAI_API_KEY).toBe("test-model-key");
  });
  it("does not allow Git or production credentials in runtime environment", () => {
    const raw = JSON.stringify({ image: "workspace:local", projects: [], runtimes: { codex: { environment: { GITHUB_TOKEN: "sensitive-value" } } } });
    expect(() => parseWorkspaceConfig(raw)).toThrow("Invalid WORKSPACE_CONFIG");
    try { parseWorkspaceConfig(raw); } catch (error) { expect(String(error)).not.toContain("sensitive-value"); }
  });
  it("requires an explicit deployment choice to expose Workspace to Agent runs", () => {
    expect(parseWorkspaceConfig(JSON.stringify({ image: "workspace:local", projects: [{ projectName: "demo", runtimes: ["codex"], agentTools: true }] }))?.projects[0]?.agentTools).toBe(true);
    expect(() => parseWorkspaceConfig(JSON.stringify({ image: "workspace:local", projects: [{ projectName: "demo", runtimes: ["codex"], agentTools: "true" }] }))).toThrow();
  });
  it("rejects ambiguous project policies and invalid repository addresses", () => {
    const project = { projectName: "demo", runtimes: ["command"] };
    expect(() => parseWorkspaceConfig(JSON.stringify({ image: "workspace:local", projects: [project, project] }))).toThrow();
    expect(() => parseWorkspaceConfig(JSON.stringify({ image: "workspace:local", projects: [{ ...project, repository: "https://internal/admin" }] }))).toThrow();
  });
});
