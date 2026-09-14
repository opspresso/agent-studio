import type { Workspace, WorkspaceInput } from "@/domain/workspace/types";

/** Tell native agents about the enforced Git boundary before each coding turn. */
export function workspaceTaskInput(workspace: Workspace, input: WorkspaceInput): WorkspaceInput {
  if (!workspace.coding || input.kind !== "task") return input;
  return { ...input, prompt: `Workspace environment contract:
Repository files are writable. Git metadata at /control/git is intentionally protected.
Read-only Git inspection is allowed. Do not run git add, commit, push, commit-tree, or other Git writes.
Do not work around this with permissions, temporary indexes, another Git directory, credentials, or GitHub APIs.
If the task requests commit or push, stop and tell the parent agent to use Workspace prepare_git and return its approval_path.
Only Studio's reviewed Git action executes publication after the user approves. Perform file changes and checks normally.

Task:
${input.prompt}` };
}
