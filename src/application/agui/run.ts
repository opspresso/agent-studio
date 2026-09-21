import { prepareDocumentAttachments } from "@/application/document/attachments";
/** Resolve current Agent settings and adapt facade output to AG-UI events. */

import type { AguiEvent, AguiRunInput, AguiTool } from "@/domain/agui/types";
import type { ChannelToolDef } from "@/domain/llm/channel";
import type { RunActor, RunCaller, RunConversation } from "@/domain/execution/actor";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import {
  streamProjectRun,
  type ExecutionDeps,
} from "@/application/execution/runProject";
import { toAguiEvents } from "./events";
import { toEngineMessages } from "./input";

export interface AguiDeps {
  projects: ProjectRepository;
  execution: ExecutionDeps;
}

/** The Project and current settings an AG-UI call runs, or null when there is none to run. */
export async function resolveAguiProject(
  deps: AguiDeps,
  name: string,
): Promise<{ project: Project; configuration: AgentConfiguration } | null> {
  const project = await deps.projects.get(name);
  if (!project) {
    return null;
  }
  const configuration = project.configuration;
  return configuration ? { project, configuration } : null;
}

export interface AguiRunRequest {
  project: Project;
  configuration: AgentConfiguration;
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
        projectName: request.project.name, actor: request.actor,
      }, documents);
      warnings.push(...result.warnings);
      return result.stored;
    },
    warnings,
  });
  const source = streamProjectRun(deps.execution, {
    project: request.project,
    configuration: request.configuration,
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
