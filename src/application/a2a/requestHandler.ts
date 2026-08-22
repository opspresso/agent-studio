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
 * **A part this agent cannot read is refused before anything runs.** The
 * protocol has an error for it (`ContentTypeNotSupported`, -32005); dropping
 * the part would run the message as if it had never been attached.
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
  TaskState,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { A2AError, DefaultRequestHandler, type ServerCallContext, type TaskStore } from "@a2a-js/sdk/server";
import { MAX_RUN_DURATION_MS } from "@/shared/runDeadline";

/** JSON-RPC code the protocol assigns to an unsupported content type. */
const CONTENT_TYPE_NOT_SUPPORTED = -32005;
/** How often a resubscribe re-reads the store. The same cadence the executor's cancel watch uses. */
const RESUBSCRIBE_POLL_MS = 2000;
const TERMINAL_STATES: readonly TaskState[] = ["completed", "canceled", "failed", "rejected"];

/** What an inbound message may carry: text, and a picture as bytes or an https address. */
export function unsupportedPart(part: Part): string | null {
  if (part.kind === "text") {
    return null;
  }
  if (part.kind === "file") {
    if (!part.file.mimeType?.startsWith("image/")) {
      return `file part of type ${part.file.mimeType ?? "unknown"}`;
    }
    if ("uri" in part.file && !part.file.uri.startsWith("https://")) {
      return "file part by a non-https uri";
    }
    return null;
  }
  return "data part";
}

export class ProjectRequestHandler extends DefaultRequestHandler {
  constructor(
    private readonly store: TaskStore,
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

  override async *resubscribe(
    params: TaskIdParams,
    _context?: ServerCallContext,
  ): AsyncGenerator<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined> {
    let task = await this.store.load(params.id);
    if (!task) {
      throw A2AError.taskNotFound(params.id);
    }
    yield task;
    let seen = artifactSignatures(task);
    const deadline = Date.now() + MAX_RUN_DURATION_MS;
    while (!TERMINAL_STATES.includes(task.status.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_POLL_MS));
      const next = await this.store.load(params.id);
      if (!next) {
        return;
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
            lastChunk: TERMINAL_STATES.includes(task.status.state),
          };
        }
      }
      seen = now;
    }
    if (TERMINAL_STATES.includes(task.status.state)) {
      yield {
        kind: "status-update",
        taskId: task.id,
        contextId: task.contextId,
        status: task.status,
        final: true,
      };
    }
  }

  /** Refuse what the executor could not honour, before a task is created for it. */
  private async admit(params: MessageSendParams): Promise<void> {
    for (const part of params.message.parts) {
      const reason = unsupportedPart(part);
      if (reason) {
        throw new A2AError(
          CONTENT_TYPE_NOT_SUPPORTED,
          `This agent accepts text parts and image file parts; the message carries a ${reason}.`,
        );
      }
    }
    const taskId = params.message.taskId;
    if (!taskId) {
      return;
    }
    const task = await this.store.load(taskId);
    if (task && !TERMINAL_STATES.includes(task.status.state) && task.status.state !== "input-required") {
      throw A2AError.invalidParams(
        `Task ${taskId} is ${task.status.state}; this agent runs each message as its own task and never waits for input. Send the message without taskId — keep contextId ${task.contextId} to stay in the conversation.`,
      );
    }
  }
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
