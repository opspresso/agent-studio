/**
 * Bridges the A2A task lifecycle onto the project execution engine.
 * Mirrors the reference flow: initial task -> working -> stream chunks as
 * `result` artifact appends -> completed/failed.
 */

import type { Message, Part, Task, TaskState } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext, TaskStore } from "@a2a-js/sdk/server";
import type { Project, Version } from "@/domain/project/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import { executeProjectStream, type ExecutionDeps } from "@/application/execution/runProject";
import { generateImage } from "@/application/image/generateImage";
import { withTimeout } from "@/lib/withTimeout";

const RESULT_ARTIFACT_ID = "result";
const IMAGE_ARTIFACT_ID = "image";
/** Wall-clock ceiling for one inbound A2A image generation (matches the run deadline). */
const IMAGE_TIMEOUT_MS = 600_000;
/** How often the run loop re-reads the store to honor a cross-request/instance cancel. */
const CANCEL_POLL_MS = 2000;
/** Task states that must never be regressed; a stored terminal task wins. */
const TERMINAL_STATES: readonly TaskState[] = ["completed", "canceled", "failed", "rejected"];

function userMessageText(message: Message): string {
  return message.parts
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("");
}

export class ProjectA2aExecutor implements AgentExecutor {
  constructor(
    private readonly deps: ExecutionDeps,
    private readonly project: Project,
    private readonly version: Version,
    private readonly store: TaskStore,
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

    // Abort in-flight work when a cancel is observed; executeProjectStream also
    // composes its own wall-clock deadline onto this signal.
    const controller = new AbortController();
    try {
      if (this.project.projectType === "image") {
        const image = await withTimeout(
          generateImage(this.deps, {
            project: this.project,
            version: this.version,
            prompt: messages[0]?.content ?? "",
          }),
          IMAGE_TIMEOUT_MS,
        );
        eventBus.publish({
          kind: "artifact-update",
          taskId,
          contextId,
          artifact: {
            artifactId: IMAGE_ARTIFACT_ID,
            name: IMAGE_ARTIFACT_ID,
            parts: [
              {
                kind: "file",
                file: {
                  bytes: image.imageBase64,
                  mimeType: image.mimeType,
                  name: `generated.${this.imageExtension(image.mimeType)}`,
                },
              },
            ],
          },
          append: false,
        });
        this.publishStatus(eventBus, taskId, contextId, "completed", true);
        return;
      }

      const source = executeProjectStream(this.deps, {
        project: this.project,
        version: this.version,
        messages,
        signal: controller.signal,
      });
      let isFirstChunk = true;
      // Check on the first chunk, then at most every CANCEL_POLL_MS.
      let lastCancelCheck = 0;
      for await (const chunk of source) {
        const now = Date.now();
        if (now - lastCancelCheck >= CANCEL_POLL_MS) {
          lastCancelCheck = now;
          // A cancel may have been persisted by another request or instance —
          // this executor is constructed per request, so an in-memory flag
          // would never reach a running loop. The store is the shared channel.
          const current = await this.store.load(taskId);
          if (current?.status.state === "canceled") {
            controller.abort();
            this.publishStatus(eventBus, taskId, contextId, "canceled", true);
            return;
          }
        }
        if (chunk.error) {
          this.publishStatus(eventBus, taskId, contextId, "failed", true, chunk.error);
          return;
        }
        const parts = this.chunkParts(chunk);
        if (parts.length === 0) {
          continue;
        }
        eventBus.publish({
          kind: "artifact-update",
          taskId,
          contextId,
          artifact: {
            artifactId: RESULT_ARTIFACT_ID,
            name: RESULT_ARTIFACT_ID,
            parts,
          },
          append: !isFirstChunk,
        });
        isFirstChunk = false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.publishStatus(eventBus, taskId, contextId, "failed", true, message);
      return;
    }

    this.publishStatus(eventBus, taskId, contextId, "completed", true);
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const task = await this.store.load(taskId);
    if (!task || TERMINAL_STATES.includes(task.status.state)) {
      return;
    }
    // Persist the cancel: the store's conditional write refuses to regress an
    // already-terminal task, so a complete/cancel race resolves to whichever
    // lands first. This makes `tasks/get` reflect the cancel and lets a running
    // loop (here or on another instance) observe it via its store poll.
    await this.store.save({
      ...task,
      status: { state: "canceled", timestamp: new Date().toISOString() },
    });
    this.publishStatus(eventBus, taskId, task.contextId, "canceled", true);
  }

  private chunkParts(chunk: EngineChunk): Part[] {
    // Only top-level assistant text goes into the artifact; subagent chunks
    // are re-authored and would duplicate the parent's final answer.
    if (chunk.author && chunk.author !== this.project.name) {
      return [];
    }
    if (chunk.image) {
      return [
        {
          kind: "file",
          file: {
            bytes: chunk.image.b64,
            mimeType: chunk.image.mimeType,
            name: `generated.${this.imageExtension(chunk.image.mimeType)}`,
          },
        },
      ];
    }
    return chunk.delta?.content ? [{ kind: "text", text: chunk.delta.content }] : [];
  }

  private imageExtension(mimeType: string): string {
    if (mimeType === "image/jpeg") {
      return "jpg";
    }
    return mimeType.split("/")[1] || "bin";
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
