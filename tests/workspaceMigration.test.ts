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
});
