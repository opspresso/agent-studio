import { describe, expect, it, vi } from "vitest";
import { assertLegacyDockerDrained } from "@/infrastructure/workspace/migrationGuard";

describe("DinD migration guard", () => {
  const present = { list: vi.fn(async () => ({ items: [{ status: { phase: "Running" } }] })) };
  it("blocks active and stopped workspace containers and unavailable infrastructure", async () => {
    await expect(assertLegacyDockerDrained(present, "studio", async () => "container-id\n")).rejects.toThrow("remain");
    await expect(assertLegacyDockerDrained(present, "studio", async () => { throw new Error("Docker unavailable"); })).rejects.toThrow("Docker unavailable");
    await expect(assertLegacyDockerDrained({ list: async () => { throw new Error("API unavailable"); } }, "studio")).rejects.toThrow("API unavailable");
  });
  it("allows a verified empty inventory and a fresh installation without a legacy daemon", async () => {
    await expect(assertLegacyDockerDrained(present, "studio", async () => "")).resolves.toBeUndefined();
    const inventory = vi.fn(async () => "unexpected");
    await expect(assertLegacyDockerDrained({ list: async () => ({ items: [] }) }, "studio", inventory)).resolves.toBeUndefined();
    expect(inventory).not.toHaveBeenCalled();
  });

  it("allows subsequent Kubernetes rollouts after the legacy daemon was retired", async () => {
    const inventory = vi.fn(async () => { throw new Error("Retired daemon"); });
    const worker = { metadata: { labels: { "app.kubernetes.io/name": "agent-studio-workspace-worker" } },
      spec: { containers: [{ name: "worker", image: "studio" }] }, status: { phase: "Running" } };
    await expect(assertLegacyDockerDrained({ list: async () => ({ items: [worker] }) }, "studio", inventory)).resolves.toBeUndefined();
    expect(inventory).not.toHaveBeenCalled();
  });

  it("still inspects an old worker's Docker sidecar and a dedicated daemon", async () => {
    for (const name of ["agent-studio-workspace-worker", "agent-studio-workspace-docker"]) {
      const pod = { metadata: { labels: { "app.kubernetes.io/name": name } },
        spec: { containers: [{ name: "worker", image: "studio" }, { name: "docker", image: "docker:dind" }] }, status: { phase: "Running" } };
      await expect(assertLegacyDockerDrained({ list: async () => ({ items: [pod] }) }, "studio", async () => "stopped-container")).rejects.toThrow("remain");
    }
  });

  it("does not treat partial or malformed inventories as proof of retirement", async () => {
    await expect(assertLegacyDockerDrained({ list: async () => ({ metadata: { _continue: "next" }, items: [] }) }, "studio")).rejects.toThrow("bound");
    const pod = { metadata: { labels: { "app.kubernetes.io/name": "agent-studio-workspace-worker" } }, status: { phase: "Running" } };
    await expect(assertLegacyDockerDrained({ list: async () => ({ items: [pod] }) }, "studio", async () => { throw new Error("Docker unavailable"); })).rejects.toThrow("Docker unavailable");
  });
});
