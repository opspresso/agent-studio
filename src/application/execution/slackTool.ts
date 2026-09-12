/** The Slack workspace read tools, over this project's own bot. */

import type * as engine from "@/application/runtime";
import type { Version } from "@/domain/project/types";
import type { ExecutionDeps } from "./deps";

/**
 * The Slack reader, or nothing when this run has no workspace to look at.
 *
 * Three separate conditions have to hold, and each means something different:
 * the version asked for the tools, the project exists, and it has an enabled
 * bot. Any of them missing leaves the run without the tools rather than with
 * tools that fail — a model offered a capability it cannot use spends turns
 * discovering that.
 *
 * The version's opt-in is checked first, so a run that did not ask for Slack
 * costs no extra project read.
 *
 * Which token the reader holds is decided by `deps.slackWorkspace`, bound by
 * the composition root: a bot token can be rotated or the integration switched
 * off between runs, so it is resolved per run rather than captured once.
 */
export async function buildSlackReader(
  deps: Pick<ExecutionDeps, "slackWorkspace" | "projects">,
  version: Version,
  projectName: string,
): Promise<engine.AgentCapabilityDeps["readSlack"]> {
  if (version.parameters.slackWorkspace !== true) {
    return undefined;
  }
  const project = await deps.projects.get(projectName);
  return (project ? deps.slackWorkspace(project) : null) ?? undefined;
}
