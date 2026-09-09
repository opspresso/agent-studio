import { describe, expect, it, vi } from "vitest";
import { assertAudioPostprocessorVersionUnused, resolveAudioPostprocessor } from "@/application/audio/postprocessVersion";
import { listModels } from "@/domain/llm/models";
import type { Project, Version } from "@/domain/project/types";
import type { AudioJobConfig } from "@/domain/audio/config";

const owner = "owner@example.test";
const project: Project = { name: "writer", displayName: "Writer", description: "", projectType: "agent", ownerEmail: owner,
  publishedVersion: "2", createdAt: "2026-01-01", updatedAt: "2026-01-02" };
const version = (versionName: string): Version => ({ projectName: project.name, versionName,
  model: listModels().find(m => m.capabilities.tools && m.capabilities.structuredOutput)!.id,
  parameters: { piiFiltering: false }, systemPrompt: "Summarize", userPromptTemplate: "", mcpList: [], skillList: [], subagentList: [], createdAt: "2026-01-01" });
const config = (versionName: string, enabled = true): AudioJobConfig => ({ projectName: "source", userEmail: owner, revision: 1,
  enabled, model: "asr", retention: { unit: "months", value: 3, timezone: "UTC" }, maxActive: 1, maxPerOccurrence: 1,
  postprocess: { projectName: project.name, versionName }, updatedAt: "2026-01-01" });

describe("postprocessing version resolution", () => {
  it("pins each published alias to the concrete version at submission", async () => {
    let published = version("1");
    const get = vi.fn(async () => published);
    const authorize = vi.fn(async () => project);
    const reference = { projectName: project.name, versionName: "published" };
    const first = await resolveAudioPostprocessor({ get }, authorize, reference, owner);
    published = version("2");
    const second = await resolveAudioPostprocessor({ get }, authorize, reference, owner);
    expect(first.versionName).toBe("1");
    expect(first.version.versionName).toBe("1");
    expect(second.versionName).toBe("2");
    expect(get).toHaveBeenCalledWith(project.name, "published");
    expect(authorize).toHaveBeenCalledWith(project.name, owner);
  });

  it("identifies a missing fixed version without silently switching models", async () => {
    const get = vi.fn(async () => null);
    await expect(resolveAudioPostprocessor({ get }, async () => project,
      { projectName: project.name, versionName: "deleted" }, owner)).rejects.toThrow('"writer/deleted" was not found');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a non-Agent project from an unsupported model", async () => {
    const get = vi.fn(async () => version("1"));
    const reference = { projectName: project.name, versionName: "1" };
    await expect(resolveAudioPostprocessor({ get }, async () => ({ ...project, projectType: "llm" }), reference, owner))
      .rejects.toThrow("requires an Agent project");
    expect(get).not.toHaveBeenCalled();
    get.mockResolvedValue({ ...version("1"), model: listModels().find(m => !m.capabilities.structuredOutput)!.id });
    await expect(resolveAudioPostprocessor({ get }, async () => project, reference, owner)).rejects.toThrow("does not support structured output");
  });
});

describe("postprocessing version deletion", () => {
  it("blocks deletion of a fixed version used by an enabled recipe", async () => {
    const deps = { projects: { list: vi.fn(async () => [{ ...project, name: "source" }]) }, configs: { get: vi.fn(async () => config("1")) } };
    await expect(assertAudioPostprocessorVersionUnused(deps, project, version("1"))).rejects.toMatchObject({ status: 409 });
  });

  it.each([config("published"), config("2"), config("1", false)])("allows an old version when the recipe does not depend on it", async (recipe) => {
    const deps = { projects: { list: vi.fn(async () => [{ ...project, name: "source" }]) }, configs: { get: vi.fn(async () => recipe) } };
    await expect(assertAudioPostprocessorVersionUnused(deps, project, version("1"))).resolves.toBeUndefined();
  });

  it("checks subsequent project pages without exposing another owner's configuration", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ ...project, name: `project-${i}`, ownerEmail: "another@example.test" }));
    const list = vi.fn(async (_limit: number, after?: string) => after ? [{ ...project, name: "source" }] : first);
    const get = vi.fn(async () => config("1"));
    await expect(assertAudioPostprocessorVersionUnused({ projects: { list }, configs: { get } }, project, version("1")))
      .rejects.toThrow('Audio configuration for "source"');
    expect(list).toHaveBeenCalledTimes(2);
    expect(get.mock.calls).toEqual([["source"]]);
  });
});
