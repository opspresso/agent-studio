import { describe, expect, it } from "vitest";
import { parseWorkspaceConfig } from "@/lib/workspaceConfig";

describe("Workspace Sandbox deployment configuration", () => {
  it("keeps only backend resources in environment configuration", () => {
    expect(parseWorkspaceConfig({ WORKSPACE_IMAGE: "workspace:test", WORKSPACE_WORKER_CONCURRENCY: "1" })).toEqual({
      image: "workspace:test", network: "none", memoryMb: 2048, diskMb: 2048, cpus: 2, workerConcurrency: 1,
    });
  });
  it("does not enable tools through legacy agent or runtime configuration", () => {
    expect(parseWorkspaceConfig({ WORKSPACE_CONFIG: JSON.stringify({ image: "workspace:test", agents: [{ agentName: "demo", agentTools: true }] }) })).toBeUndefined();
    expect(parseWorkspaceConfig({})).toBeUndefined();
    expect(parseWorkspaceConfig({ WORKSPACE_IMAGE: " " })).toBeUndefined();
  });
  it.each(["0", "33", "secret-value"])("rejects invalid concurrency without echoing environment contents (%s)", value => {
    expect(() => parseWorkspaceConfig({ WORKSPACE_IMAGE: "workspace:test", WORKSPACE_WORKER_CONCURRENCY: value })).toThrow("Invalid Workspace Sandbox infrastructure configuration");
  });
});
