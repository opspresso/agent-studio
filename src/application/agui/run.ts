import { prepareDocumentAttachments } from "@/application/document/attachments";
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

import type { AguiEvent, AguiRunInput, AguiTool } from "@/domain/agui/types";
import type { ChannelToolDef } from "@/domain/llm/channel";
import type { RunActor, RunCaller, RunConversation } from "@/domain/execution/actor";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import {
  streamProjectRun,
  type ExecutionDeps,
} from "@/application/execution/runProject";
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

/**
 * Run the project and answer in AG-UI events.
 *
 * The application's tools reach the agent loop and nothing else: a prompt
 * project answers in one call and an image project draws, and neither has a
 * turn a tool call could end. Declared against one of those, they are
 * reported rather than dropped — the client offered them and would otherwise
 * wait for calls that can never come. Stripped here rather than handed on,
 * because the facade refuses them for those types: that refusal is for a
 * caller that did not check, and this one did.
 */
export async function* streamAguiRun(
  deps: AguiDeps,
  request: AguiRunRequest,
): AsyncGenerator<AguiEvent> {
  const clientTools = request.input.tools.map(toChannelTool);
  const warnings: string[] = [];
  // Documents are read here, before the run opens: an unreadable attachment
  // is a warning beside the answer, reported with the surface's own.
  const messages = await toEngineMessages(request.input.messages, request.input.context, request.input.state, {
    documents: deps.execution.documents,
    prepareDocuments: async (documents) => {
      const result = await prepareDocumentAttachments(deps.execution.documents, deps.execution.artifacts, {
        projectName: request.project.name, versionName: request.version.versionName, actor: request.actor,
      }, documents);
      warnings.push(...result.warnings);
      return result.stored;
    },
    warnings,
  });
  const source = streamProjectRun(deps.execution, {
    project: request.project,
    version: request.version,
    messages,
    actor: request.actor,
    ...(request.caller ? { caller: request.caller } : {}),
    ...(request.conversation ? { conversation: request.conversation } : {}),
    ...(clientTools.length > 0 ? { clientTools } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  yield* toAguiEvents(
    source,
    {
      threadId: request.input.threadId,
      runId: request.input.runId,
      ...(request.input.parentRunId ? { parentRunId: request.input.parentRunId } : {}),
    },
    { sign: deps.execution.artifacts?.objects.sign, warnings },
  );
}

function toChannelTool(tool: AguiTool): ChannelToolDef {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    },
  };
}
