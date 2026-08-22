/**
 * A published project run over AG-UI.
 *
 * The surface's whole job is two decisions the protocol leaves to the agent:
 * which version answers — the published one, and only that, because an
 * application embedding this project is an external surface like A2A and a
 * draft must not leak through it — and how the engine's chunks become the
 * protocol's events (`events.ts`). The run itself is the facade's:
 * `streamProjectRun`, so an agent project loops over its tools, a prompt
 * project answers once, and an image project draws — a chat panel can show
 * any of the three.
 */

import type { AguiEvent, AguiRunInput } from "@/domain/agui/types";
import type { RunActor, RunCaller, RunConversation } from "@/domain/execution/actor";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import { streamProjectRun, type ExecutionDeps } from "@/application/execution/runProject";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { toAguiEvents } from "./events";
import { toEngineMessages } from "./input";

export interface AguiDeps {
  projects: ProjectRepository;
  versions: VersionRepository;
  execution: ExecutionDeps;
}

/** The project and the version an AG-UI call runs, or null when there is none to run. */
export async function resolveAguiProject(
  deps: AguiDeps,
  name: string,
): Promise<{ project: Project; version: Version } | null> {
  const project = await deps.projects.get(name);
  if (!project) {
    return null;
  }
  const version = await resolveRunnableVersion(deps.versions, project);
  return version ? { project, version } : null;
}

export interface AguiRunRequest {
  project: Project;
  version: Version;
  input: AguiRunInput;
  actor: RunActor;
  caller?: RunCaller;
  conversation?: RunConversation;
  signal?: AbortSignal;
}

/** Run the project and answer in AG-UI events. */
export function streamAguiRun(deps: AguiDeps, request: AguiRunRequest): AsyncGenerator<AguiEvent> {
  const source = streamProjectRun(deps.execution, {
    project: request.project,
    version: request.version,
    messages: toEngineMessages(request.input.messages, request.input.context),
    actor: request.actor,
    ...(request.caller ? { caller: request.caller } : {}),
    ...(request.conversation ? { conversation: request.conversation } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return toAguiEvents(
    source,
    { threadId: request.input.threadId, runId: request.input.runId },
    { sign: deps.execution.artifacts?.objects.sign },
  );
}
