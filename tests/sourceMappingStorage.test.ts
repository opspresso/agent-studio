import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { mcpBindingSchema } from "@/app/api/projects/_lib/schemas";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
import * as store from "@/infrastructure/db/store";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import { versionRepository } from "@/infrastructure/db/repositories/versionRepository";
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const mapping = { tool: "asset", namespace: "account", urlPath: ["url"], idPath: ["id"], mimeType: "audio/mpeg" };
beforeEach(() => { fake.rows.clear(); });

describe("source mapping persistence", () => {
  it("round-trips registry defaults and refuses malformed stored defaults", async () => {
    await mcpRepository.put({ name: "files", url: "https://files.example.test/mcp", headers: {}, createdAt: "before", updatedAt: "before", sourceOutputs: [mapping] });
    expect((await mcpRepository.get("files"))?.sourceOutputs).toEqual([mapping]);
    fake.seed([{ ...keys.mcp("files"), sourceOutputs: "invalid" }]);
    await expect(mcpRepository.get("files")).rejects.toThrow("source mappings are invalid");
  });
  it("preserves version-owned mappings on repository reads", async () => {
    fake.seed([{ ...keys.version("audio", "1"), projectName: "audio", versionName: "1",
      mcpList: [{ name: "files", sourceOutputs: [mapping] }] }]);
    expect((await versionRepository.get("audio", "1"))?.mcpList[0]?.sourceOutputs).toEqual([mapping]);
  });
  it("rejects malformed stored mappings instead of falling back to raw output", async () => {
    fake.seed([{ ...keys.version("audio", "1"), projectName: "audio", versionName: "1",
      mcpList: [{ name: "files", sourceOutputs: "broken" }] }]);
    await expect(versionRepository.get("audio", "1")).rejects.toThrow("source mappings are invalid");
  });
  it("rejects duplicate tools and unsafe paths at the API boundary", () => {
    expect(mcpBindingSchema.safeParse({ name: "files", sourceOutputs: [mapping, mapping] }).success).toBe(false);
    expect(mcpBindingSchema.safeParse({ name: "files", sourceOutputs: [{ ...mapping, idPath: ["constructor"] }] }).success).toBe(false);
    expect(mcpBindingSchema.safeParse({ name: "files", sourceOutputs: [mapping] }).success).toBe(true);
  });
});
