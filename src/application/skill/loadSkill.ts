import type { Skill, SkillFile } from "@/domain/skill/types";
import { describeSkillFileReject, resolveSkillFile } from "@/domain/skill/files";

/**
 * Attachment paths the model can load through `file_path`, even when SKILL.md
 * does not list them. Returned with the body and with rejected file requests.
 *
 * Bounded by construction: `MAX_SKILL_FILES` caps a skill at 20 paths, so the
 * line has no budget of its own to spend.
 */
function fileList(files: readonly SkillFile[]): string {
  return files.map((file) => file.path).join(", ");
}

/**
 * What a run may still ask this skill for, said after a `file_path` that could
 * not be served. A skill with no attachments says so rather than listing
 * nothing: "no such file" and "this skill has no files at all" are different
 * facts, and only the second one tells the model to stop guessing.
 */
function availableFiles(files: readonly SkillFile[]): string {
  return files.length > 0
    ? `Files in this skill: ${fileList(files)}.`
    : "This skill has no files; load it without file_path for its body.";
}

/**
 * Resolve what the builtin `Skill` tool returns. Without a `filePath` it returns
 * the SKILL.md body, followed by the attachment paths when the skill has any;
 * with one it returns the exact attachment, or a reason-specific error that
 * names what could have been asked for instead. Errors are returned as text so
 * the model sees them as the tool result rather than as a thrown failure.
 */
export function loadSkillFileContent(
  skill: Skill | null,
  skillName: string,
  filePath?: string,
): string {
  if (!skill) {
    return `Error: Skill '${skillName}' not found in database.`;
  }
  const files = skill.files ?? [];
  if (filePath === undefined || filePath.trim() === "") {
    const body = skill.content ?? "";
    if (files.length === 0) {
      // Byte-identical to the body for a skill that has nothing to disclose —
      // an index is never announced with nothing behind it.
      return body;
    }
    return [body, `Files in this skill, loadable with this tool's file_path: ${fileList(files)}`]
      .filter((part) => part !== "")
      .join("\n\n");
  }
  const result = resolveSkillFile(files, filePath);
  if (result.ok) {
    return result.content;
  }
  return `Error: cannot load '${filePath}' from skill '${skillName}': ${describeSkillFileReject(result.reason)}. ${availableFiles(files)}`;
}
