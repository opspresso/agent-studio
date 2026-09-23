import type { WorkspaceEvent } from "@/domain/workspace/types";

/** Text that actually grows the Workspace output pane. */
export function workspaceOutputText(event: WorkspaceEvent): string {
  const data = event.data;
  if (data.kind === "output" || data.kind === "message") return data.text;
  if (data.kind === "warning") return `\n⚠ ${data.text}\n`;
  return "";
}
