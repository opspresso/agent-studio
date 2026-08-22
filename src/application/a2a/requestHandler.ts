/**
 * The SDK's request handler, with the three answers this deployment has to
 * give for itself.
 *
 * **A message may not continue a task that is not waiting for one.** The
 * executor runs each message as its own run and never enters `input-required`,
 * so a `taskId` naming a live task would start a second run on it — two
 * streams writing the same `result` artifact, each resetting the other. The
 * SDK refuses a terminal task; the non-terminal case is refused here, with
 * the contextId named as the way to stay in the conversation.
 *
 * **A part this agent cannot read is refused before anything runs**, and a
 * picture is bounded the way every other surface bounds one — by type, size
 * and count, from `imageLimits`. The protocol has an error for it
 * (`ContentTypeNotSupported`, -32005); dropping the part would run the message
 * as if it had never been attached.
 *
 * **`tasks/resubscribe` has no bus to attach to.** The executor publishes on
 * an event bus the SDK keeps per *request*, and a resubscribe is a different
 * request — on a scaled deployment, usually a different instance. The store
 * is what both share, so a resubscribe follows the store: the snapshot, then
 * each artifact as it lands, then the terminal status. Slower than a bus by
 * one poll interval, and the only thing that works across instances.
 */

import type {
  Message,
  MessageSendParams,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { A2AError, DefaultRequestHandler, type ServerCallContext, type TaskStore } from "@a2a-js/sdk/server";
import { isLiveTaskState, isTerminalTaskState } from "@/domain/a2a/task";
import {
  base64ByteLength,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";
import { MAX_RUN_DURATION_MS } from "@/shared/runDeadline";

/** JSON-RPC code the protocol assigns to an unsupported content type. */
const CONTENT_TYPE_NOT_SUPPORTED = -32005;
/** How often a resubscribe re-reads the store. The same cadence the executor's cancel watch uses. */
const RESUBSCRIBE_POLL_MS = 2000;

/**
 * What an inbound message may carry: text, and a picture of a type, size and
 * count the run would accept from any other surface. The reason, when there
 * is one, names the part so the caller can fix it.
 */
export function unsupportedPart(part: Part): string | null {
  if (part.kind === "text") {
    return null;
  }
  if (part.kind === "file") {
    const mimeType = part.file.mimeType ?? "unknown";
    if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mimeType)) {
      return `file part of type ${mimeType}`;
    }
    if ("uri" in part.file) {
      return part.file.uri.startsWith("https://") ? null : "file part by a non-https uri";
    }
    if (base64ByteLength(part.file.bytes) > MAX_ATTACHMENT_BYTES) {
      return `image larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`;
    }
    return null;
  }
  return "data part";
}

export interface ProjectRequestHandlerOptions {
  /** The request's own end: a resubscribe stops following the store when the reader is gone. */
  signal?: AbortSignal;
}

export class ProjectRequestHandler extends DefaultRequestHandler {
  constructor(
    private readonly store: TaskStore,
    private readonly options: ProjectRequestHandlerOptions,
    ...rest: ConstructorParameters<typeof DefaultRequestHandler>
  ) {
    super(...rest);
  }

  override async sendMessage(params: MessageSendParams, context?: ServerCallContext): Promise<Message | Task> {
    await this.admit(params);
    return super.sendMessage(params, context);
  }

  override async *sendMessageStream(
    params: MessageSendParams,
    context?: ServerCallContext,
  ): AsyncGenerator<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined> {
    await this.admit(params);
    yield* super.sendMessageStream(params, context);
  }

  /**
   * The snapshot, each artifact as it changes, then the ending. A task that
   * never settles within the run deadline — its instance died holding it — is
   * reported as an error rather than a stream that closes in silence, and a
   * reader that leaves stops the polling with it.
   */
  override async *resubscribe(
    params: TaskIdParams,
    _context?: ServerCallContext,
  ): AsyncGenerator<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined> {
    const signal = this.options.signal;
    let task = await this.store.load(params.id);
    if (!task) {
      throw A2AError.taskNotFound(params.id);
    }
    yield task;
    let seen = artifactSignatures(task);
    const deadline = Date.now() + MAX_RUN_DURATION_MS;
    while (!isTerminalTaskState(task.status.state)) {
      if (Date.now() >= deadline) {
        throw A2AError.internalError(
          `Task ${params.id} did not settle within the run deadline; it is still ${task.status.state}.`,
        );
      }
      if (!(await pollDelay(RESUBSCRIBE_POLL_MS, signal))) {
        return;
      }
      const next = await this.store.load(params.id);
      if (!next) {
        throw A2AError.taskNotFound(params.id);
      }
      task = next;
      const now = artifactSignatures(task);
      for (const artifact of task.artifacts ?? []) {
        if (seen.get(artifact.artifactId) !== now.get(artifact.artifactId)) {
          yield {
            kind: "artifact-update",
            taskId: task.id,
            contextId: task.contextId,
            artifact,
            append: false,
          };
        }
      }
      seen = now;
    }
    // Every artifact is closed as the protocol closes one — an empty append
    // marked last — whether or not its final change landed in the same poll
    // as the terminal status.
    for (const artifact of task.artifacts ?? []) {
      yield {
        kind: "artifact-update",
        taskId: task.id,
        contextId: task.contextId,
        artifact: { artifactId: artifact.artifactId, name: artifact.name, parts: [] },
        append: true,
        lastChunk: true,
      };
    }
    yield {
      kind: "status-update",
      taskId: task.id,
      contextId: task.contextId,
      status: task.status,
      final: true,
    };
  }

  /** Refuse what the executor could not honour, before a task is created for it. */
  private async admit(params: MessageSendParams): Promise<void> {
    let pictures = 0;
    for (const part of params.message.parts) {
      const reason = unsupportedPart(part);
      if (reason) {
        throw new A2AError(
          CONTENT_TYPE_NOT_SUPPORTED,
          `This agent accepts text parts and image file parts (${SUPPORTED_IMAGE_TYPES.join(", ")}, up to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB each, ${MAX_ATTACHMENTS} per message); the message carries a ${reason}.`,
        );
      }
      if (part.kind === "file") {
        pictures += 1;
      }
    }
    if (pictures > MAX_ATTACHMENTS) {
      throw new A2AError(
        CONTENT_TYPE_NOT_SUPPORTED,
        `This agent accepts at most ${MAX_ATTACHMENTS} images per message; the message carries ${pictures}.`,
      );
    }
    const taskId = params.message.taskId;
    if (!taskId) {
      return;
    }
    const task = await this.store.load(taskId);
    if (task && isLiveTaskState(task.status.state)) {
      throw A2AError.invalidParams(
        `Task ${taskId} is ${task.status.state}; this agent runs each message as its own task and never waits for input. Send the message without taskId — keep contextId ${task.contextId} to stay in the conversation.`,
      );
    }
  }
}

/** Waits, or answers false the moment the reader is gone. The listener does not outlive the wait. */
function pollDelay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One string per artifact that changes when its parts do, for the cheapest "anything new?". */
function artifactSignatures(task: Task): Map<string, string> {
  return new Map(
    (task.artifacts ?? []).map((artifact) => [
      artifact.artifactId,
      `${artifact.parts.length}:${JSON.stringify(artifact.parts).length}`,
    ]),
  );
}
