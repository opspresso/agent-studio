/**
 * Bridges the A2A task lifecycle onto the project execution engine.
 * Mirrors the reference flow: initial task -> working -> stream chunks as
 * `result` artifact appends -> completed/failed.
 */

import type { Message, Part, Task, TaskState } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext, TaskStore } from "@a2a-js/sdk/server";
import type { Project, Version } from "@/domain/project/types";
import { collectedWarning, isTopLevelChunk, messageText } from "@/domain/llm/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import {
  executeProjectStream,
  runStrategyFor,
  type ExecutionDeps,
} from "@/application/execution/runProject";
import { generateImage } from "@/application/image/generateImage";
import { fileRefOf, resolveProducedFile } from "@/application/artifact/producedFiles";
import { VIEW_URL_TTL_SECONDS } from "@/application/artifact/urlTtl";
import { A2A_ACTOR_ID, type RunActor } from "@/domain/execution/actor";
import { log } from "@/shared/logger";
import { unrefTimer } from "@/shared/unrefTimer";

/**
 * The shared app key authenticates every machine caller as one anonymous
 * identity; a named client key resolves to its own actor at the route. The
 * kind still separates this spend from every human's.
 */
const A2A_ACTOR: RunActor = { kind: "a2a", id: A2A_ACTOR_ID };

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
    private readonly actor: RunActor = A2A_ACTOR,
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
      if (runStrategyFor(this.project) === "image") {
        const image = await generateImage(this.deps, {
          project: this.project,
          version: this.version,
          prompt: messages[0] ? messageText(messages[0]) : "",
          actor: this.actor,
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
        actor: this.actor,
        signal: controller.signal,
      });
      let isFirstChunk = true;
      // What the run reported alongside its answer — a binding it could not
      // use, a turn or budget limit it hit. A2A has no warning frame, so these
      // ride out on the terminal status message; dropping them left an A2A
      // caller as the one consumer that could never learn why an answer came
      // back short.
      const warnings: string[] = [];
      for await (const chunk of source) {
        if (controller.signal.aborted) {
          this.publishStatus(eventBus, taskId, contextId, "canceled", true);
          return;
        }
        // Only a top-level error fails the task. An authored one is a subagent
        // failure the engine reports to the parent as a tool error — the
        // parent usually answers past it, and failing here threw that answer
        // away (and left the trace recorded as cancelled).
        if (chunk.error && isTopLevelChunk(chunk)) {
          this.publishStatus(eventBus, taskId, contextId, "failed", true, chunk.error);
          return;
        }
        // Authored ones included: a subagent's loss is this task's too, and
        // filtering to top-level here was how an A2A caller stayed the one
        // consumer a child's lost binding never reached.
        const warning = collectedWarning(chunk, warnings);
        if (warning) {
          warnings.push(warning);
        }
        // A file a tool produced, resolved as it passes. Its bytes were stripped
        // at the bracket, so unlike an image it travels as an address — and when
        // there is none, the reason joins the warnings rather than the task
        // quietly completing without the document it was asked for.
        const produced = chunk.file ? await this.filePart(chunk.file) : undefined;
        if (produced?.warning && !warnings.includes(produced.warning)) {
          warnings.push(produced.warning);
        }
        const parts = [...(produced?.part ? [produced.part] : []), ...this.chunkParts(chunk)];
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
      // A limited run still completes the task — the partial answer was
      // delivered — but the caller is told what the run reported (its turn or
      // output limit, a binding it could not use, budget truncation) rather
      // than being left to read a short artifact as the whole answer. The
      // engine's own warning text travels as-is; a second spelling of it here
      // had already drifted once.
      if (warnings.length > 0) {
        await this.publishTerminal(eventBus, taskId, contextId, controller, warnings.join("\n"));
        return;
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
    message?: string,
  ): Promise<void> {
    if (!controller.signal.aborted) {
      let current: Task | undefined;
      try {
        current = await this.store.load(taskId);
      } catch (error) {
        log.error("a2a", "terminal cancel check failed", error);
      }
      if (current?.status.state !== "canceled") {
        this.publishStatus(eventBus, taskId, contextId, "completed", true, message);
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
          log.error("a2a", "cancel poll failed", error);
        },
      );
    }, CANCEL_POLL_MS);
    unrefTimer(timer);
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

  /**
   * A produced file as an A2A file part, addressed by uri.
   *
   * `bytes` is not an option: the run bracket stored the document and dropped
   * the payload from the chunk long before this sees it. The signature outlives
   * the run comfortably but not the stored task — a `tasks/get` days later reads
   * a link that has expired, and the artifact is still in the console. That is
   * the trade for not carrying megabytes through a task store.
   */
  private async filePart(
    file: NonNullable<EngineChunk["file"]>,
  ): Promise<{ part?: Part; warning?: string }> {
    const outcome = await resolveProducedFile(
      fileRefOf(file),
      this.deps.artifacts?.objects.sign,
      VIEW_URL_TTL_SECONDS,
    );
    if (!outcome.file) {
      return outcome.warning ? { warning: outcome.warning } : {};
    }
    return {
      part: {
        kind: "file",
        file: {
          uri: outcome.file.url!,
          mimeType: outcome.file.mimeType,
          name: outcome.file.name,
        },
      },
    };
  }

  private chunkParts(chunk: EngineChunk): Part[] {
    // Images are collected from subagent turns too, like `collectRun`'s: an
    // image subagent is how an agent project delegates drawing, and the
    // picture is the answer. Behind the top-level gate below, that delegation
    // published a `completed` task with no artifact at all.
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
    // Only top-level assistant text goes into the artifact; subagent chunks
    // are re-authored and would duplicate the parent's final answer.
    if (!isTopLevelChunk(chunk)) {
      return [];
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
    message?: string,
  ): void {
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      final,
      status: {
        state,
        timestamp: new Date().toISOString(),
        ...(message
          ? {
              message: {
                kind: "message",
                messageId: crypto.randomUUID(),
                role: "agent",
                parts: [{ kind: "text", text: message }],
                taskId,
                contextId,
              },
            }
          : {}),
      },
    });
  }
}
