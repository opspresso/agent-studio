import { describe, expect, it } from "vitest";
import { projectHasAudioTools } from "@/domain/project/audioAccess";
import type { Version } from "@/domain/project/types";

const version = (name: string, enabled: boolean, createdAt: string) => ({ versionName: name, parameters: { audioProcessing: enabled }, createdAt }) as Version;
describe("audio page availability", () => {
  it("uses the published version even when a newer draft has the opposite setting", () => {
    const versions = [version("1", false, "2026-01-01"), version("2", true, "2026-01-02")];
    expect(projectHasAudioTools({ projectType: "agent", publishedVersion: "1" }, versions)).toBe(false);
    expect(projectHasAudioTools({ projectType: "agent", publishedVersion: "2" }, versions)).toBe(true);
  });
  it("uses the most recently created saved version before publication", () => {
    const versions = [version("new", true, "2026-01-02"), version("old", false, "2026-01-01")];
    expect(projectHasAudioTools({ projectType: "agent" }, versions)).toBe(true);
    expect(projectHasAudioTools({ projectType: "agent" }, [...versions, version("newest", false, "2026-01-03")])).toBe(false);
  });
  it("hides audio for non-agents, missing versions and broken publication pointers", () => {
    expect(projectHasAudioTools({ projectType: "llm" }, [version("1", true, "2026-01-01")])).toBe(false);
    expect(projectHasAudioTools({ projectType: "agent" }, [])).toBe(false);
    expect(projectHasAudioTools({ projectType: "agent", publishedVersion: "missing" }, [version("1", true, "2026-01-01")])).toBe(false);
  });
});
