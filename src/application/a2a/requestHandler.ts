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
 * **`ResubscribeTask` has no bus to attach to.** The executor publishes on
 * an event bus the SDK keeps per *request*, and a resubscribe is a different
 * request — on a scaled deployment, usually a different instance. The store
 * is what both share, so a resubscribe follows the store: the snapshot, then
 * each artifact as it lands, then the terminal status. Slower than a bus by
 * one poll interval, and the only thing that works across instances.
 */

import type {
  Message,
  Part,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
} from "@a2a-js/sdk";
import {
  ContentTypeNotSupportedError,
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { DefaultRequestHandler, type ServerCallContext, type TaskStore } from "@a2a-js/sdk/server";
import { isLiveTaskState, isTerminalTaskState, taskStateName } from "@/domain/a2a/task";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";
import { MAX_RUN_DURATION_MS } from "@/shared/runDeadline";

/** How often a resubscribe re-reads the store. The same cadence the executor's cancel watch uses. */
const RESUBSCRIBE_POLL_MS = 2000;

/**
 * What an inbound message may carry: text, and a picture of a type, size and
 * count the run would accept from any other surface. The reason, when there
 * is one, names the part so the caller can fix it.
 */
export function unsupportedPart(part: Part): string | null {
  if (part.content?.$case === "text") {
    return null;
  }
  if (part.content?.$case === "raw" || part.content?.$case === "url") {
    const mimeType = part.mediaType || "unknown";
    if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mimeType)) {
      return `file part of type ${mimeType}`;
    }
    if (part.content.$case === "url") {
      return "image file part by URL";
    }
    if (part.content.value.byteLength > MAX_ATTACHMENT_BYTES) {
      return `image larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`;
    }
    return null;
  }
  return part.content?.$case === "data" ? "data part" : "part with no content";
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

  override async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    await this.admit(params, context);
    return super.sendMessage(params, context);
  }

  override async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    await this.admit(params, context);
    yield* super.sendMessageStream(params, context);
  }

  /**
   * The snapshot, each artifact as it changes, then the ending. A task that
   * never settles within the run deadline — its instance died holding it — is
   * reported as an error rather than a stream that closes in silence, and a
   * reader that leaves stops the polling with it.
   */
  override async *resubscribe(
    params: SubscribeToTaskRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const signal = this.options.signal;
    let task = await this.store.load(params.id, context);
    if (!task) {
      throw new TaskNotFoundError(`Task ${params.id} was not found.`);
    }
    if (task.status && isTerminalTaskState(task.status.state)) {
      throw new UnsupportedOperationError(
        `Task ${params.id} is already ${taskStateName(task.status.state)} and cannot be resubscribed.`,
      );
    }
    yield { payload: { $case: "task", value: task } };
    let seen = artifactSignatures(task);
    let seenStatus = statusSignature(task);
    const deadline = Date.now() + MAX_RUN_DURATION_MS;
    while (!task.status || !isTerminalTaskState(task.status.state)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Task ${params.id} did not settle within the run deadline; it is still ${task.status ? taskStateName(task.status.state) : "unspecified"}.`,
        );
      }
      if (!(await pollDelay(RESUBSCRIBE_POLL_MS, signal))) {
        return;
      }
      const next = await this.store.load(params.id, context);
      if (!next) {
        throw new TaskNotFoundError(`Task ${params.id} was not found.`);
      }
      task = next;
      const now = artifactSignatures(task);
      for (const artifact of task.artifacts ?? []) {
        if (seen.get(artifact.artifactId) !== now.get(artifact.artifactId)) {
          yield {
            payload: {
              $case: "artifactUpdate",
              value: {
                taskId: task.id,
                contextId: task.contextId,
                artifact,
                append: false,
                lastChunk: false,
                metadata: undefined,
              },
            },
          };
        }
      }
      seen = now;
      const nextStatus = statusSignature(task);
      if (
        nextStatus !== seenStatus &&
        task.status &&
        !isTerminalTaskState(task.status.state)
      ) {
        yield {
          payload: {
            $case: "statusUpdate",
            value: {
              taskId: task.id,
              contextId: task.contextId,
              status: task.status,
              metadata: undefined,
            },
          },
        };
      }
      seenStatus = nextStatus;
    }
    // Re-send the final full artifact as a replacement carrying `lastChunk`.
    // A2A 1.0 requires a non-empty Artifact; an empty append cannot be used as
    // an end marker.
    for (const artifact of task.artifacts ?? []) {
      yield {
        payload: {
          $case: "artifactUpdate",
          value: {
            taskId: task.id,
            contextId: task.contextId,
            artifact,
            append: false,
            lastChunk: true,
            metadata: undefined,
          },
        },
      };
    }
    yield {
      payload: {
        $case: "statusUpdate",
        value: {
          taskId: task.id,
          contextId: task.contextId,
          status: task.status,
          metadata: undefined,
        },
      },
    };
  }

  /** Refuse what the executor could not honour, before a task is created for it. */
  private async admit(params: SendMessageRequest, context: ServerCallContext): Promise<void> {
    if (!params.message) {
      throw new RequestMalformedError("SendMessage requires a message.");
    }
    let pictures = 0;
    for (const part of params.message.parts) {
      const reason = unsupportedPart(part);
      if (reason) {
        throw new ContentTypeNotSupportedError(
          `This agent accepts text parts and image file parts (${SUPPORTED_IMAGE_TYPES.join(", ")}, up to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB each, ${MAX_ATTACHMENTS} per message); the message carries a ${reason}.`,
        );
      }
      if (part.content?.$case === "raw" || part.content?.$case === "url") {
        pictures += 1;
      }
    }
    if (pictures > MAX_ATTACHMENTS) {
      throw new ContentTypeNotSupportedError(
        `This agent accepts at most ${MAX_ATTACHMENTS} images per message; the message carries ${pictures}.`,
      );
    }
    const taskId = params.message.taskId;
    if (!taskId) {
      return;
    }
    const task = await this.store.load(taskId, context);
    if (task?.status && isLiveTaskState(task.status.state)) {
      throw new RequestMalformedError(
        `Task ${taskId} is ${taskStateName(task.status.state)}; this agent runs each message as its own task and never waits for input. Send the message without taskId — keep contextId ${task.contextId} to stay in the conversation.`,
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

function statusSignature(task: Task): string {
  return JSON.stringify(task.status);
}
