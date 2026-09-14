/** Workspace scripts and configured checks stop on failed commands or unset variables. */
export const WORKSPACE_SHELL = ["/bin/sh", "-eu", "-s"] as const;
