export const WORKSPACE_ACTIVITY_EVENT = "workspaces:activity";
export function notifyWorkspaceActivity() { window.dispatchEvent(new Event(WORKSPACE_ACTIVITY_EVENT)); }
