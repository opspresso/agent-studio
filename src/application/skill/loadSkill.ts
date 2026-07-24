import type { Skill } from "@/domain/skill/types";
import { describeSkillFileReject, resolveSkillFile } from "@/domain/skill/files";

/**
 * Resolve what the builtin `Skill` tool returns. Without a `filePath` it returns
 * the SKILL.md body (unchanged legacy behavior); with one it returns the exact
 * attachment or a reason-specific error. Errors are returned as text so the model
 * sees them as the tool result rather than as a thrown failure.
 */
export function loadSkillFileContent(
  skill: Skill | null,
  skillName: string,
  filePath?: string,
): string {
  if (!skill) {
    return `Error: Skill '${skillName}' not found in database.`;
  }
  if (filePath === undefined || filePath.trim() === "") {
    return skill.content ?? "";
  }
  const result = resolveSkillFile(skill.files ?? [], filePath);
  if (result.ok) {
    return result.content;
  }
  return `Error: cannot load '${filePath}' from skill '${skillName}': ${describeSkillFileReject(result.reason)}.`;
}
