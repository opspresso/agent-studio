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

const RESULT_ARTIFACT_ID = "result";
const IMAGE_ARTIFACT_ID = "image";
/** How often the background watcher re-reads the store to honor a cross-request/instance cancel. */
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

    // A cancel may be persisted by another request or instance (the executor is
    // per request, so an in-memory flag never reaches a running loop). Poll the
    // shared store in the background and abort so even a run producing no new
    // chunks — a hung provider, or a single image call — stops promptly.
    const controller = new AbortController();
    const stopCancelWatch = this.watchForCancel(taskId, controller);
    try {
      if (this.project.projectType === "image") {
        const image = await generateImage(this.deps, {
          project: this.project,
          version: this.version,
          prompt: messages[0]?.content ?? "",
          signal: controller.signal,
        });
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
        await this.publishTerminal(eventBus, taskId, contextId, controller);
        return;
      }

      const source = executeProjectStream(this.deps, {
        project: this.project,
        version: this.version,
        messages,
        signal: controller.signal,
      });
      let isFirstChunk = true;
      for await (const chunk of source) {
        if (controller.signal.aborted) {
          this.publishStatus(eventBus, taskId, contextId, "canceled", true);
          return;
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
      // An abort here means the cancel watcher fired mid-run — report canceled.
      if (controller.signal.aborted) {
        this.publishStatus(eventBus, taskId, contextId, "canceled", true);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.publishStatus(eventBus, taskId, contextId, "failed", true, message);
      return;
    } finally {
      stopCancelWatch();
    }

    await this.publishTerminal(eventBus, taskId, contextId, controller);
  }

  /**
   * Publish the run's terminal status, deferring to a cancel that raced in. The
   * controller is a lagging replica synced by the background poll, so a cancel
   * persisted between polls (before the run finished) would not have aborted it;
   * consult the authoritative store before ever publishing completed over a
   * canceled task.
   */
  private async publishTerminal(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    controller: AbortController,
  ): Promise<void> {
    if (!controller.signal.aborted) {
      let current: Task | undefined;
      try {
        current = await this.store.load(taskId);
      } catch (error) {
        console.error("[a2a] terminal cancel check failed", error);
      }
      if (current?.status.state !== "canceled") {
        this.publishStatus(eventBus, taskId, contextId, "completed", true);
        return;
      }
    }
    this.publishStatus(eventBus, taskId, contextId, "canceled", true);
  }

  /** Poll the shared store in the background; abort the run once a cancel lands. */
  private watchForCancel(taskId: string, controller: AbortController): () => void {
    const timer = setInterval(() => {
      void this.store.load(taskId).then(
        (task) => {
          if (task?.status.state === "canceled") {
            controller.abort();
          }
        },
        (error) => {
          console.error("[a2a] cancel poll failed", error);
        },
      );
    }, CANCEL_POLL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
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
