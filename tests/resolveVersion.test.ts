import { describe, expect, it } from "vitest";
import { resolveVersion } from "@/application/chat/run";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import type { ChatDeps } from "@/application/chat/deps";
import type { VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";

const PROJECT = { name: "p" } as Project;

function versionFixture(versionName: string, createdAt: string): Version {
  return {
    projectName: "p",
    versionName,
    systemPrompt: "",
    userPromptTemplate: "",
    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt,
  };
}

function depsWith(published: Version | null, all: Version[]): ChatDeps {
  return {
    versions: {
      async get(_projectName: string, versionName: string) {
        return versionName === "published" ? published : null;
      },
      async list() {
        return all;
      },
    },
  } as unknown as ChatDeps;
}

describe("resolveVersion fallback order", () => {
  it("returns the published version when the pointer resolves", async () => {
    const published = versionFixture("2", "2026-01-02T00:00:00.000Z");
    const resolved = await resolveVersion(
      depsWith(published, [versionFixture("1", "2026-01-01T00:00:00.000Z"), published]),
      PROJECT,
    );
    expect(resolved?.versionName).toBe("2");
  });

  it("falls back to the latest version by createdAt when nothing is published", async () => {
    const resolved = await resolveVersion(
      depsWith(null, [
        versionFixture("2", "2026-01-02T00:00:00.000Z"),
        versionFixture("3", "2026-01-03T00:00:00.000Z"),
        versionFixture("1", "2026-01-01T00:00:00.000Z"),
      ]),
      PROJECT,
    );
    expect(resolved?.versionName).toBe("3");
  });

  it("returns null when the project has no versions", async () => {
    expect(await resolveVersion(depsWith(null, []), PROJECT)).toBeNull();
  });
});

describe("resolveRunnableVersion policy", () => {
  it("never leaks a draft when draft fallback is off (external surfaces)", async () => {
    const draft = versionFixture("1", "2026-01-01T00:00:00.000Z");
    const versions = {
      async get() {
        return null;
      },
      async list() {
        return [draft];
      },
    } as unknown as VersionRepository;

    expect(await resolveRunnableVersion(versions, PROJECT)).toBeNull();
    const withFallback = await resolveRunnableVersion(versions, PROJECT, {
      allowDraftFallback: true,
    });
    expect(withFallback?.versionName).toBe("1");
  });
});
