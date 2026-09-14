import type { Workspace, WorkspaceInput } from "@/domain/workspace/types";

/** Tell native agents about the enforced Git boundary before each coding turn. */
export function workspaceTaskInput(workspace: Workspace, input: WorkspaceInput): WorkspaceInput {
  if (input.kind !== "task") return input;
  return { ...input, prompt: `Workspace environment contract:
The current working directory is writable. Use relative paths there for task files.
The workspace_path returned by Studio is a browser link, not a filesystem directory. Do not cd to /chats paths.
${workspace.coding ? `Repository files are writable. Git metadata at /control/git is intentionally protected.
Read-only Git inspection is allowed. Do not run git add, commit, push, commit-tree, or other Git writes.
Do not work around this with permissions, temporary indexes, another Git directory, credentials, or GitHub APIs.
If the task requests commit or push, stop and tell the parent agent to use Workspace prepare_git and return its approval_path.
Only Studio's reviewed Git action executes publication after the user approves. Perform file changes and checks normally.` : "This Workspace has no Git repository attached. Do not assume a configured repository was cloned."}

Task:
${input.prompt}` };
}
