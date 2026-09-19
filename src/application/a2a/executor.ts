/**
 * Bridges the A2A task lifecycle onto the project execution engine.
 * Mirrors the reference flow: initial task -> working -> stream chunks as
 * `result` artifact appends -> completed/failed.
 */

import { TaskState, type Message, type Part, type Task } from "@a2a-js/sdk";
import { imageDataUrl, type ContentPart } from "@/domain/llm/types";
import {
  AgentEvent,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from "@a2a-js/sdk/server";
import type { Project, Version } from "@/domain/project/types";
import { collectedWarning, isTopLevelChunk } from "@/domain/llm/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import {
  executeProjectStream,
  type ExecutionDeps,
} from "@/application/execution/runProject";
import { fileRefOf, resolveProducedFile } from "@/application/artifact/producedFiles";
import { RECORD_URL_TTL_SECONDS } from "@/shared/artifactUrlTtl";
import { A2A_ACTOR_ID, type RunActor } from "@/domain/execution/actor";
import { a2aConversation } from "@/domain/a2a/conversation";
import { log } from "@/shared/logger";
import { startSequentialPoll } from "@/shared/sequentialPoll";
import { agentMessage, artifact, partText, rawPart, taskStatus, textPart, urlPart } from "@/domain/a2a/protocol";

/**
 * The shared app key authenticates every machine caller as one anonymous
 * identity; a named client key resolves to its own actor at the route. The
 * kind still separates this spend from every human's.
 */
const A2A_ACTOR: RunActor = { kind: "a2a", id: A2A_ACTOR_ID };

const RESULT_ARTIFACT_ID = "result";
/** How often the background watcher re-reads the store to honor a cross-request/instance cancel. */
const CANCEL_POLL_MS = 2000;
import { isTerminalTaskState } from "@/domain/a2a/task";

function userMessageText(message: Message): string {
  return message.parts.map(partText).join("");
}

/**
 * The message as the engine takes it: its text, and any picture it carried
 * as an inline image part. A part the handler did not admit never reaches here
 * (`ProjectRequestHandler`), so nothing is dropped silently.
 */
function userMessageContent(message: Message): ChatMessageInput["content"] {
  const images: ContentPart[] = message.parts.flatMap((part) => {
    if (!part.mediaType.startsWith("image/")) {
      return [];
    }
    const url = part.content?.$case === "raw"
      ? imageDataUrl({ b64: Buffer.from(part.content.value).toString("base64"), mimeType: part.mediaType })
      : undefined;
    if (!url) {
      return [];
    }
    return [{ type: "image_url" as const, image_url: { url } }];
  });
  const text = userMessageText(message);
  if (images.length === 0) {
    return text;
  }
  return [...(text ? [{ type: "text" as const, text }] : []), ...images];
}

export class ProjectA2aExecutor implements AgentExecutor {
  constructor(
    private readonly deps: ExecutionDeps,
    private readonly project: Project,
    private readonly version: Version,
    private readonly store: TaskStore,
    private readonly actor: RunActor = A2A_ACTOR,
    private readonly callContext: ServerCallContext = new ServerCallContext(),
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;

    const initialTask: Task = requestContext.task ?? {
      id: taskId,
      contextId,
      status: taskStatus(TaskState.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [userMessage],
      metadata: undefined,
    };
    // A2A 1.0 requires every execution, including a follow-up, to begin with
    // a Task or Message event before any delta event.
    eventBus.publish(AgentEvent.task(initialTask));
    this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_WORKING);

    const messages: ChatMessageInput[] = [{ role: "user", content: userMessageContent(userMessage) }];

    // A cancel may be persisted by another request or instance (the executor is
    // per request, so an in-memory flag never reaches a running loop). Poll the
    // shared store in the background and abort so even a run producing no new
    // chunks — a hung provider, or a single image call — stops promptly.
    const controller = new AbortController();
    const stopCancelWatch = this.watchForCancel(taskId, controller, requestContext.context);
    // The caller's `contextId` is its conversation for every project type.
    const conversation = a2aConversation(this.actor, contextId);
    try {
      // The caller's `contextId` is its conversation: a second message in it
      // reaches an MCP server and any onward transfer as the same one.
      const source = executeProjectStream(this.deps, {
        project: this.project,
        version: this.version,
        messages,
        actor: this.actor,
        ...(conversation ? { conversation } : {}),
        signal: controller.signal,
      });
      let sentArtifact = false;
      let pendingParts: Part[] | undefined;
      // What the run reported alongside its answer — a binding it could not
      // use, a turn or budget limit it hit. A2A has no warning frame, so these
      // ride out on the terminal status message; dropping them left an A2A
      // caller as the one consumer that could never learn why an answer came
      // back short.
      const warnings: string[] = [];
      for await (const chunk of source) {
        if (controller.signal.aborted) {
          this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_CANCELED);
          return;
        }
        // Only a top-level error fails the task. An authored one is a subagent
        // failure the engine reports to the parent as a tool error — the
        // parent usually answers past it, and failing here threw that answer
        // away (and left the trace recorded as cancelled).
        if (chunk.error && isTopLevelChunk(chunk)) {
          this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_FAILED, chunk.error);
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
        if (pendingParts) {
          this.publishArtifact(eventBus, taskId, contextId, pendingParts, sentArtifact, false);
          sentArtifact = true;
        }
        pendingParts = parts;
      }
      // Hold one non-empty update until the next arrives, so the actual last
      // content can carry `lastChunk`. A2A 1.0 forbids an empty Artifact, so an
      // empty append used only as an end marker is not a valid frame.
      if (pendingParts) {
        this.publishArtifact(eventBus, taskId, contextId, pendingParts, sentArtifact, true);
      }
      // A limited run still completes the task — the partial answer was
      // delivered — but the caller is told what the run reported (its turn or
      // output limit, a binding it could not use, budget truncation) rather
      // than being left to read a short artifact as the whole answer. The
      // engine's own warning text travels as-is; a second spelling of it here
      // had already drifted once.
      if (warnings.length > 0) {
        await this.publishTerminal(
          eventBus,
          taskId,
          contextId,
          controller,
          requestContext.context,
          warnings.join("\n"),
        );
        return;
      }
    } catch (error) {
      // An abort here means the cancel watcher fired mid-run — report canceled.
      if (controller.signal.aborted) {
        this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_CANCELED);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_FAILED, message);
      return;
    } finally {
      stopCancelWatch();
    }

    await this.publishTerminal(eventBus, taskId, contextId, controller, requestContext.context);
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
    context: ServerCallContext,
    message?: string,
  ): Promise<void> {
    if (!controller.signal.aborted) {
      let current: Task | undefined;
      try {
        current = await this.store.load(taskId, context);
      } catch (error) {
        log.error("a2a", "terminal cancel check failed", error);
      }
      if (current?.status?.state !== TaskState.TASK_STATE_CANCELED) {
        this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_COMPLETED, message);
        return;
      }
    }
    this.publishStatus(eventBus, taskId, contextId, TaskState.TASK_STATE_CANCELED);
  }

  /** Poll the shared store in the background; abort the run once a cancel lands. */
  private watchForCancel(
    taskId: string,
    controller: AbortController,
    context: ServerCallContext,
  ): () => void {
    return startSequentialPoll({
      intervalMs: CANCEL_POLL_MS,
      poll: async (signal) => {
        const task = await this.store.load(taskId, context);
        if (!signal.aborted && task?.status?.state === TaskState.TASK_STATE_CANCELED) {
          controller.abort();
        }
      },
      onError: (error) => log.error("a2a", "cancel poll failed", error),
    });
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const task = await this.store.load(taskId, this.callContext);
    if (!task?.status || isTerminalTaskState(task.status.state)) {
      return;
    }
    // Persist the cancel: the store's conditional write refuses to regress an
    // already-terminal task, so a complete/cancel race resolves to whichever
    // lands first. This makes `GetTask` reflect the cancel and lets a running
    // loop (here or on another instance) observe it via its store poll.
    await this.store.save({
      ...task,
      status: taskStatus(TaskState.TASK_STATE_CANCELED),
    }, this.callContext);
    this.publishStatus(eventBus, taskId, task.contextId, TaskState.TASK_STATE_CANCELED);
  }

  /**
   * A produced file as an A2A URL part.
   *
   * `bytes` is not an option: the run bracket stored the document and dropped
   * the payload from the chunk long before this sees it. That is the trade for
   * not carrying megabytes through a task store.
   *
   * Signed for a record rather than for a present reader. A task is stored and
   * read back later — a non-streaming `SendMessage` client does not see this
   * artifact until the run completes, which may be ten minutes after the chunk
   * carrying it passed — so the window has to outlast the run by a wide margin
   * rather than by minutes. Even {@link RECORD_URL_TTL_SECONDS} runs out
   * eventually; the artifact itself stays in the console.
   */
  private async filePart(
    file: NonNullable<EngineChunk["file"]>,
  ): Promise<{ part?: Part; warning?: string }> {
    const outcome = await resolveProducedFile(
      fileRefOf(file),
      this.deps.artifacts?.objects.sign,
      RECORD_URL_TTL_SECONDS,
    );
    if (!outcome.file) {
      return outcome.warning ? { warning: outcome.warning } : {};
    }
    return {
      part: { ...urlPart(outcome.file.url!, outcome.file.mimeType, outcome.file.name), ...(outcome.file.fileId ? { metadata: { fileId: outcome.file.fileId } } : {}) },
    };
  }

  private chunkParts(chunk: EngineChunk): Part[] {
    // Images are collected from subagent turns too, like `collectRun`'s: an
    // image subagent is how an agent project delegates drawing, and the
    // picture is the answer. Behind the top-level gate below, that delegation
    // published a `completed` task with no artifact at all.
    if (chunk.image) {
      return [
        rawPart(
          chunk.image.b64,
          chunk.image.mimeType,
          `generated.${this.imageExtension(chunk.image.mimeType)}`,
        ),
      ];
    }
    // Only top-level assistant text goes into the artifact; subagent chunks
    // are re-authored and would duplicate the parent's final answer.
    if (!isTopLevelChunk(chunk)) {
      return [];
    }
    return chunk.delta?.content ? [textPart(chunk.delta.content)] : [];
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
    message?: string,
  ): void {
    eventBus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: taskStatus(
        state,
        message ? agentMessage(crypto.randomUUID(), contextId, taskId, message) : undefined,
      ),
      metadata: undefined,
    }));
  }

  private publishArtifact(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    parts: Part[],
    append: boolean,
    lastChunk: boolean,
  ): void {
    eventBus.publish(AgentEvent.artifactUpdate({
      taskId,
      contextId,
      artifact: artifact(RESULT_ARTIFACT_ID, parts),
      append,
      lastChunk,
      metadata: undefined,
    }));
  }
}
