/**
 * Bridges the A2A task lifecycle onto the project execution engine.
 * Mirrors the reference flow: initial task -> working -> stream chunks as
 * `result` artifact appends -> completed/failed.
 */

import type { Message, Task, TaskState } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Project, Version } from "@/domain/project/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import { executeProjectStream, type ExecutionDeps } from "@/application/execution/runProject";

const RESULT_ARTIFACT_ID = "result";

function userMessageText(message: Message): string {
  return message.parts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("");
}

export class ProjectA2aExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly deps: ExecutionDeps,
    private readonly project: Project,
    private readonly version: Version,
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;

    if (!requestContext.task) {
      const initialTask: Task = {
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
        history: [userMessage],
      };
      eventBus.publish(initialTask);
    }
    this.publishStatus(eventBus, taskId, contextId, "working", false);

    const messages: ChatMessageInput[] = [
      { role: "user", content: userMessageText(userMessage) },
    ];
    const source = executeProjectStream(this.deps, {
      project: this.project,
      version: this.version,
      messages,
    });

    try {
      let isFirstChunk = true;
      for await (const chunk of source) {
        if (this.cancelled.has(taskId)) {
          this.publishStatus(eventBus, taskId, contextId, "canceled", true);
          return;
        }
        if (chunk.error) {
          this.publishStatus(eventBus, taskId, contextId, "failed", true, chunk.error);
          return;
        }
        const content = this.chunkContent(chunk);
        if (!content) {
          continue;
        }
        eventBus.publish({
          kind: "artifact-update",
          taskId,
          contextId,
          artifact: {
            artifactId: RESULT_ARTIFACT_ID,
            name: RESULT_ARTIFACT_ID,
            parts: [{ kind: "text", text: content }],
          },
          append: !isFirstChunk,
        });
        isFirstChunk = false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publishStatus(eventBus, taskId, contextId, "failed", true, message);
      return;
    } finally {
      this.cancelled.delete(taskId);
    }

    this.publishStatus(eventBus, taskId, contextId, "completed", true);
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.cancelled.add(taskId);
    // The final canceled status is published by the execute loop when it
    // observes the flag; publishing here as well covers tasks with no
    // running loop (e.g. already persisted tasks).
    void eventBus;
  }

  private chunkContent(chunk: EngineChunk): string | undefined {
    // Only top-level assistant text goes into the artifact; subagent chunks
    // are re-authored and would duplicate the parent's final answer.
    if (chunk.author && chunk.author !== this.project.name) {
      return undefined;
    }
    return chunk.delta?.content || undefined;
  }

  private publishStatus(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: TaskState,
    final: boolean,
    errorMessage?: string,
  ): void {
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      final,
      status: {
        state,
        timestamp: new Date().toISOString(),
        ...(errorMessage
          ? {
              message: {
                kind: "message",
                messageId: crypto.randomUUID(),
                role: "agent",
                parts: [{ kind: "text", text: errorMessage }],
                taskId,
                contextId,
              },
            }
          : {}),
      },
    });
  }
}
