/**
 * Outbound A2A client for registry agents with `protocol: "a2a"`.
 * Resolves the Agent Card from the stored URL, asks for the reply as a stream,
 * and extracts the text from the returned Message or Task (artifacts take
 * precedence over the final status message, which some remote agents use to
 * repeat or summarize artifact content).
 *
 * **Streaming is what lets a long delegation finish.** A blocking `message/send`
 * puts nothing on the connection while the remote works, and a gateway reads
 * that silence as idle and cuts it — a remote investigation that runs for
 * minutes returns a timeout rather than an answer. Status updates keep bytes
 * flowing, so the idle judgement never comes up. Which path is taken is read
 * off the card's `capabilities.streaming` **before anything is sent**, and that
 * is deliberate: it is the one question whose answer is known without a
 * request, so there is no failure to retry and no setting to add. Trying the
 * stream first and falling back on error would be the same feature with a
 * double-execution bug in it — an HTTP error can arrive from a gateway *after*
 * the remote accepted the work.
 */

import type {
  AgentCard,
  Message,
  MessageSendParams,
  Part,
  Task,
  TaskArtifactUpdateEvent,
} from "@a2a-js/sdk";
import { A2AClient } from "@a2a-js/sdk/client";
import { awaitsInput, isFailedTaskState, isLiveTaskState, isTerminalTaskState } from "@/domain/a2a/task";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { readBodyText } from "@/shared/httpBody";

export interface A2aImage {
  b64: string;
  mimeType: string;
  name?: string;
}

export type A2aSendResult =
  | {
      ok: true;
      text: string;
      images: A2aImage[];
      /**
       * The remote conversation this reply belongs to. A task carries the
       * `contextId` the remote grouped it under; a bare message reply carries
       * its own. Handed back so the next send from the same conversation can
       * continue it — see `A2aSendOptions.contextId`.
       */
      contextId?: string;
    }
  | {
      ok: false;
      error: string;
      /** The task the remote parked to ask for input — see `RemoteAgentReply`. */
      continuation?: { contextId: string; taskId: string };
    };

export interface A2aSendOptions {
  /**
   * Continue an existing remote conversation. The protocol's own mechanism:
   * a message carrying the `contextId` an earlier reply named is grouped with
   * it server-side, and a remote that keeps history keeps answering in it.
   * Absent, the remote opens a new one — which is what every send did before
   * this option existed.
   */
  contextId?: string;
  /** The task an earlier reply left `input-required`; this message answers it. */
  taskId?: string;
}

const AGENT_CARD_SUFFIX = "/.well-known/agent-card.json";
/**
 * How long the exchange may stay *silent*, not how long it may take.
 *
 * A streaming remote can work far longer than any single gap between its
 * updates, so a bound on the whole exchange would cut exactly the runs
 * streaming exists to carry. The total is capped by the run's own deadline,
 * which arrives as `signal`. The blocking path has no events to reset it, so
 * there the same number is the whole-request bound it always was.
 */
const IDLE_TIMEOUT_MS = 120_000;
/** An Agent Card is a small JSON document; nothing here reads a body unbounded. */
const MAX_CARD_BYTES = 1_000_000;
/**
 * The most of a reply that is kept. A remote's artifacts accumulate in memory
 * as they stream and enter the parent's context as text, so a bound belongs
 * here as it does on every other remote answer (`docs/CONFIGURATION.md`).
 */
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
/** How often a blocking send that was answered with a live task asks again. */
const TASK_POLL_MS = 2000;


/** Accepts either the card URL itself or the agent base URL. */
export function normalizeAgentCardUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith(AGENT_CARD_SUFFIX) ? trimmed : `${trimmed}${AGENT_CARD_SUFFIX}`;
}

function partsText(parts: Part[]): string {
  return parts.map((part) => (part.kind === "text" ? part.text : "")).join("");
}

function partsImages(parts: Part[]): A2aImage[] {
  return parts.flatMap((part) => {
    if (part.kind !== "file" || !("bytes" in part.file)) {
      return [];
    }
    const file = part.file;
    if (!file.mimeType?.startsWith("image/")) {
      return [];
    }
    return [
      {
        b64: file.bytes,
        mimeType: file.mimeType,
        ...(file.name ? { name: file.name } : {}),
      },
    ];
  });
}

/** What a reply weighs, counted as the bytes its parts serialise to. */
function partsBytes(parts: Part[]): number {
  return parts.reduce((total, part) => total + JSON.stringify(part).length, 0);
}

function resultParts(result: Message | Task): Part[] {
  if (result.kind === "message") {
    return result.parts;
  }
  return (result.artifacts ?? []).flatMap((artifact) => artifact.parts);
}

export function extractA2aText(result: Message | Task): string {
  if (result.kind === "message") {
    return partsText(result.parts);
  }
  const artifactText = (result.artifacts ?? [])
    .map((artifact) => partsText(artifact.parts))
    .join("");
  if (artifactText) {
    return artifactText;
  }
  if (result.status.message) {
    const statusText = partsText(result.status.message.parts);
    if (statusText) {
      return statusText;
    }
  }
  for (const message of [...(result.history ?? [])].reverse()) {
    if (message.role === "agent") {
      const text = partsText(message.parts);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

export function extractA2aImages(result: Message | Task): A2aImage[] {
  return partsImages(resultParts(result));
}

/** One entry of a task's `artifacts`, named without restating the SDK's aliases. */
type TaskArtifact = NonNullable<Task["artifacts"]>[number];

/**
 * A status or artifact event that arrived before the task it belongs to.
 *
 * The protocol sends the task first, so this is the defensive branch — but a
 * remote that skips it would otherwise have its whole answer dropped, and the
 * event carries the two identifiers a task needs.
 */
function ensureTask(task: Task | null, event: { taskId: string; contextId: string }): Task {
  return (
    task ?? {
      kind: "task",
      id: event.taskId,
      contextId: event.contextId,
      status: { state: "working" },
    }
  );
}

/** `append` continues an artifact already sent; anything else replaces it. */
function mergeArtifact(task: Task, event: TaskArtifactUpdateEvent): Task {
  const artifacts = task.artifacts ?? [];
  const existing = artifacts.find((a) => a.artifactId === event.artifact.artifactId);
  if (!existing) {
    return { ...task, artifacts: [...artifacts, event.artifact] };
  }
  const merged: TaskArtifact = event.append
    ? { ...existing, ...event.artifact, parts: [...existing.parts, ...event.artifact.parts] }
    : event.artifact;
  return { ...task, artifacts: artifacts.map((a) => (a === existing ? merged : a)) };
}

/** States after which the task will not change again. */


interface StreamCollected {
  /** Null when the stream failed before producing anything usable. */
  result: Message | Task | null;
  error?: string;
}

/**
 * Fold the stream's events back into the value the blocking send would have
 * returned, so both paths are read by the same two extractors — that, rather
 * than a second copy of the artifacts-over-status rule, is what keeps the two
 * answers identical.
 */
async function collectStream(
  client: A2AClient,
  params: MessageSendParams,
  onEvent: () => void,
  idle: AbortSignal,
  caller?: AbortSignal,
): Promise<StreamCollected> {
  let task: Task | null = null;
  let message: Message | null = null;
  // Counted as the parts arrive rather than re-summed over the whole task per
  // event; an upper bound, since a replaced artifact is counted again.
  let received = 0;
  try {
    for await (const event of client.sendMessageStream(params)) {
      onEvent();
      switch (event.kind) {
        case "message":
          message = event;
          break;
        case "task":
          task = event;
          break;
        case "status-update": {
          const base = ensureTask(task, event);
          task = {
            ...base,
            status: event.status,
            /*
             * The blocking path receives a server-built `history`, and that is
             * what `extractA2aText` falls through to when a remote puts its
             * answer in a status message rather than an artifact. Nothing else
             * fills it here, so without this a streamed run reports "no
             * supported content" for a reply the blocking one reads fine.
             */
            ...(event.status.message
              ? { history: [...(base.history ?? []), event.status.message] }
              : {}),
          };
          /*
           * The terminal event ends the exchange. The SDK's generator runs
           * until the response *body* closes rather than until this marker, so
           * a remote (or a proxy) that holds the connection open afterwards
           * would otherwise cost the whole idle bound — and then time out with
           * the finished answer already in hand.
           */
          if (event.final) {
            return { result: task };
          }
          break;
        }
        case "artifact-update":
          task = mergeArtifact(ensureTask(task, event), event);
          // Bounded as it accumulates, not after: the whole point of a bound
          // on a streamed reply is that it stops the stream.
          received += partsBytes(event.artifact.parts);
          if (received > MAX_REPLY_BYTES) {
            return {
              result: null,
              error: `A2A reply exceeds ${MAX_REPLY_BYTES / (1024 * 1024)}MB`,
            };
          }
          break;
      }
    }
  } catch (error) {
    /*
     * A stream that broke *after* its terminal event still delivered the
     * answer: a proxy resetting the connection, or a single trailing frame the
     * SDK cannot parse, must not discard a task that is already complete.
     * Anything short of terminal is a genuine loss and reported as one.
     */
    if (task && isTerminalTaskState(task.status.state)) {
      return { result: task };
    }
    return { result: null, error: errorText(error, idle, caller) };
  }
  // A task is the fuller record whenever there is one: it carries the artifacts,
  // the terminal status and the history the extractors fall through.
  return { result: task ?? message };
}

/**
 * The card, read here rather than through `A2AClient.fromCardUrl` so the
 * streaming capability is in hand before a request is sent. Same single fetch
 * the SDK helper does — it ends in this same constructor.
 */
async function loadAgentCard(cardUrl: string, fetchImpl: typeof fetch): Promise<AgentCard> {
  const response = await fetchImpl(cardUrl, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Agent Card from ${cardUrl}: ${response.status} ${response.statusText}`,
    );
  }
  const body = await readBodyText(response, MAX_CARD_BYTES);
  try {
    return JSON.parse(body) as AgentCard;
  } catch {
    throw new Error(`Agent Card at ${cardUrl} is not JSON`);
  }
}

/**
 * The reply as the run reads it. The task's state decides first: a `failed`
 * task carries its reason in a status message, and read for its text alone
 * that reason became the answer — the parent model relayed "Agent execution
 * error: …" as what the remote said. An `input-required` task is the remote
 * asking a question, which is not an answer either; the question goes out as
 * the error and the task ids with it, so the next transfer can answer it.
 */
function toResult(result: Message | Task): A2aSendResult {
  if (partsBytes(resultParts(result)) > MAX_REPLY_BYTES) {
    return { ok: false, error: `A2A reply exceeds ${MAX_REPLY_BYTES / (1024 * 1024)}MB` };
  }
  const text = extractA2aText(result);
  if (result.kind === "task") {
    const state = result.status.state;
    if (isFailedTaskState(state)) {
      return { ok: false, error: `Remote task ${state}${text ? `: ${text}` : ""}` };
    }
    if (awaitsInput(state)) {
      return {
        ok: false,
        error: `Remote agent needs input before it can continue${text ? `: ${text}` : ""}`,
        ...(result.contextId ? { continuation: { contextId: result.contextId, taskId: result.id } } : {}),
      };
    }
  }
  const images = extractA2aImages(result);
  if (!text && images.length === 0) {
    const state = result.kind === "task" ? result.status.state : "message";
    return { ok: false, error: `A2A reply contained no supported content (state: ${state})` };
  }
  // Both shapes carry one; the field is optional on a message and the SDK
  // types it as such, so it is read defensively either way.
  const contextId = typeof result.contextId === "string" && result.contextId ? result.contextId : undefined;
  return { ok: true, text, images, ...(contextId ? { contextId } : {}) };
}

/**
 * `idle` is our own bound, `caller` the run's. Which one fired is read off the
 * signals rather than off the error: `fetch` rejects with whatever a signal was
 * aborted *with*, and only a bare `abort()` is the DOM's `AbortError` — a
 * caller that hung up arrives as Next's `ResponseAborted`, an Error with
 * another name and no message, which matched by name read as an ordinary
 * failure with nothing to say. Reporting a run cancelled by its caller as a
 * 120-second timeout would describe a wait that never happened, so the two are
 * kept apart here.
 */
function errorText(error: unknown, idle: AbortSignal, caller?: AbortSignal): string {
  if (idle.aborted) {
    return `Request timed out after ${IDLE_TIMEOUT_MS / 1000}s with no response`;
  }
  if (caller?.aborted) {
    return "Request was cancelled";
  }
  return error instanceof Error && error.message ? error.message : "A2A request failed";
}

export async function sendA2aMessage(
  url: string,
  headers: Record<string, string>,
  message: string,
  signal?: AbortSignal,
  options: A2aSendOptions = {},
): Promise<A2aSendResult> {
  const controller = new AbortController();
  let idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  const keepAwake = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const fetchImpl: typeof fetch = (input, init) =>
    fetchPublicUrl(input, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      signal: requestSignal,
    });

  const params: MessageSendParams = {
    message: {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "user",
      parts: [{ kind: "text", text: message }],
      ...(options.contextId ? { contextId: options.contextId } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
    },
    configuration: {
      acceptedOutputModes: ["text/plain", "image/png", "image/jpeg", "image/webp"],
    },
  };

  try {
    const cardUrl = normalizeAgentCardUrl(url);
    const card = await loadAgentCard(cardUrl, fetchImpl);
    // The operator's headers are credentials for the address the entry was
    // registered at. The guard refuses a cross-origin *redirect* for exactly
    // that reason, and a card naming another origin as its endpoint is the
    // same thing said in JSON: a card is a document a third party serves.
    const cardOrigin = new URL(cardUrl).origin;
    const endpointOrigin = safeOrigin(card.url);
    if (endpointOrigin !== cardOrigin) {
      return {
        ok: false,
        error: `Agent Card names an endpoint on ${endpointOrigin ?? "an unreadable address"}, not on ${cardOrigin}; the registered headers are not sent there`,
      };
    }
    const client = new A2AClient(card, { fetchImpl });
    keepAwake();
    if (card.capabilities?.streaming) {
      const streamed = await collectStream(client, params, keepAwake, controller.signal, signal);
      return streamed.result
        ? toResult(streamed.result)
        : { ok: false, error: streamed.error ?? "A2A stream ended with no reply" };
    }
    // No events to reset the idle bound, so here it is the whole-request one.
    const response = await client.sendMessage({
      ...params,
      configuration: { ...params.configuration, blocking: true },
    });
    if ("error" in response) {
      return { ok: false, error: `A2A error ${response.error.code}: ${response.error.message}` };
    }
    return toResult(await settled(client, response.result, requestSignal));
  } catch (error) {
    return { ok: false, error: errorText(error, controller.signal, signal) };
  } finally {
    clearTimeout(idleTimer);
  }
}

/** The origin of an address, or nothing for one that does not parse. */
function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * A blocking send may be answered with a task still running — the protocol
 * lets a server return early and expects the caller to poll — so a live task
 * is followed through `tasks/get` until it settles. Bounded by the request's
 * own signals: the idle timer is the whole-request bound on this path.
 */
async function settled(client: A2AClient, result: Message | Task, signal: AbortSignal): Promise<Message | Task> {
  let current = result;
  while (current.kind === "task" && isLiveTaskState(current.status.state)) {
    await sleepUnlessAborted(TASK_POLL_MS, signal);
    const polled = await client.getTask({ id: current.id });
    if ("error" in polled) {
      throw new Error(`A2A error ${polled.error.code}: ${polled.error.message}`);
    }
    current = polled.result;
  }
  return current;
}

/**
 * Wait, or stop waiting the moment the signal fires. The listener is removed
 * on the normal path — a task polled thirty times would otherwise leave thirty
 * listeners on the request's signal — and an already-aborted signal never
 * fires again, so it is checked before the wait rather than listened for.
 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
