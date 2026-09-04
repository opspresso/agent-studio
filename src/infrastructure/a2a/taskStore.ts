/**
 * Database-backed A2A task store. Replaces the SDK's in-memory store so inbound
 * A2A task state (`SendMessage` → `GetTask`/`CancelTask`) survives instance
 * restarts and is shared across horizontally-scaled instances.
 *
 * The store is per-project: keys are namespaced by project name, so a task
 * created for one project is invisible to another project's store (isolation by
 * construction, matching the previous per-project in-memory stores).
 *
 * Concurrency: the SDK's `TaskStore.save` is a blind overwrite, so the
 * terminal-state guard lives here. A conditional write refuses to overwrite a
 * task that is already in a terminal state, so a complete/cancel race resolves
 * to whichever terminal transition lands first and never regresses.
 */

import { TaskState, type ListTasksRequest, type ListTasksResponse, type Message, type Part, type Task } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import { keys } from "@/infrastructure/db/keys";
import {
  CONDITIONAL_WRITE_FAILED,
  countItems,
  getItem,
  putItem,
  queryItems,
  type QueryInput,
} from "@/infrastructure/db/store";
import { RETENTION, expiresAtSeconds, isExpired } from "@/infrastructure/db/ttl";

import { A2A_TERMINAL_STATES as TERMINAL_STATES } from "@/domain/a2a/task";

/**
 * The most a stored task may weigh, measured against the whole stored item.
 * A task is read whole on every `GetTask` and every row of a `ListTasks`
 * page, so the bound keeps those reads cheap. When a task
 * exceeds it, {@link fitTask} degrades the payload in steps — drop inline
 * file bytes, then drop history/artifacts — so the task's state and metadata
 * always stay retrievable rather than failing the write.
 */
const MAX_ITEM_BYTES = 350_000;

function stripPartBytes(parts: Part[] | undefined): Part[] | undefined {
  return parts?.map((part) =>
    part.content?.$case === "raw" && part.content.value.byteLength > 0
      ? { ...part, content: { $case: "raw" as const, value: Buffer.alloc(0) } }
      : part,
  );
}

/** Blank inline file bytes (e.g. a generated image already streamed to the client). */
function stripFileBytes(task: Task): Task {
  const stripMessage = (message: Message): Message => ({
    ...message,
    parts: stripPartBytes(message.parts) ?? message.parts,
  });
  return {
    ...task,
    artifacts: task.artifacts?.map((artifact) => ({
      ...artifact,
      parts: stripPartBytes(artifact.parts) ?? artifact.parts,
    })),
    history: task.history?.map(stripMessage),
  };
}

/**
 * Raw part bytes across the JSON boundary. The store keeps a document, and
 * `JSON.stringify` turns a `Buffer` into `{type:"Buffer",data:[…]}` — an
 * object that reads back as an object, not as bytes: `byteLength` is
 * `undefined`, so a reloaded oversized part is never stripped on re-save and
 * the SDK serialises the wrong shape. Base64 on the way in, bytes on the way
 * out, applied to every part a task carries.
 */
function mapParts(task: Task, map: (part: Part) => Part): Task {
  return {
    ...task,
    artifacts: task.artifacts?.map((artifact) => ({
      ...artifact,
      parts: artifact.parts?.map(map),
    })),
    history: task.history?.map((message) => ({ ...message, parts: message.parts?.map(map) })),
  };
}

const BASE64_CASE = "raw-base64";

function toStoredTask(task: Task): Task {
  return mapParts(task, (part) =>
    part.content?.$case === "raw"
      ? ({
          ...part,
          content: { $case: BASE64_CASE, value: Buffer.from(part.content.value).toString("base64") },
        } as unknown as Part)
      : part,
  );
}

function fromStoredTask(stored: Task): Task {
  return mapParts(stored, (part) => {
    const content = part.content as { $case?: string; value?: unknown } | undefined;
    return content?.$case === BASE64_CASE && typeof content.value === "string"
      ? { ...part, content: { $case: "raw" as const, value: Buffer.from(content.value, "base64") } }
      : part;
  });
}

/** Last resort: keep the task's state + metadata, drop the bulky collections so
 * the item fits and `GetTask` still resolves. */
function dropBulkParts(task: Task): Task {
  return { ...task, history: [], artifacts: [] };
}

/**
 * Pick the largest representation whose FULL stored item fits under
 * {@link MAX_ITEM_BYTES}: whole → without inline file bytes → without history →
 * without artifacts either. History goes before artifacts because the
 * artifacts *are* the answer: a completed task a `GetTask` returns with no
 * artifact reads as a run that produced nothing, where one with no history
 * has only lost the echo of what it was asked. The last form is returned even
 * if still over (best effort), because a retrievable state beats a rejected
 * write.
 */
function fitTask(task: Task, wrapper: Record<string, unknown>): Task {
  const fits = (candidate: Task) =>
    Buffer.byteLength(JSON.stringify({ ...wrapper, task: candidate }), "utf8") <= MAX_ITEM_BYTES;
  if (fits(task)) {
    return task;
  }
  const withoutBytes = stripFileBytes(task);
  if (fits(withoutBytes)) {
    return withoutBytes;
  }
  const withoutHistory = { ...withoutBytes, history: [] };
  if (fits(withoutHistory)) {
    return withoutHistory;
  }
  return dropBulkParts(task);
}

/** A database-backed {@link TaskStore} scoped to a single project. */
export function createA2aTaskStore(projectName: string): TaskStore {
  return {
    async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
      const item = await getItem(keys.a2aTask(projectName, ownerScope(context), taskId));
      if (!item || isExpired(item.expiresAt, Date.now())) {
        return undefined;
      }
      return fromStoredTask(item.task as Task);
    },

    async save(task: Task, context: ServerCallContext): Promise<void> {
      const now = new Date().toISOString();
      const scope = ownerScope(context);
      const wrapper = {
        ...keys.a2aTask(projectName, scope, task.id),
        ...keys.a2aTaskList(projectName, scope, sortableTimestamp(task), task.id),
        entityType: "a2aTask",
        projectName,
        ownerScope: scope,
        taskId: task.id,
        contextId: task.contextId,
        state: task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
        updatedAt: now,
        expiresAt: expiresAtSeconds(now, RETENTION.a2aTaskDays),
      };
      try {
        await putItem(
          { ...wrapper, task: toStoredTask(fitTask(task, wrapper)) },
          (row) =>
            row === null || !(TERMINAL_STATES as readonly unknown[]).includes(row.state),
        );
      } catch (error) {
        // Losing side of a complete/cancel race: the stored terminal state wins,
        // so this write is a no-op. Any other failure propagates.
        if ((error as { name?: string }).name === CONDITIONAL_WRITE_FAILED) {
          return;
        }
        throw error;
      }
    },

    async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
      validateListRequest(params);
      const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 50));
      const cursor = pageCursor(params.pageToken);
      const scope = ownerScope(context);
      const filter: Record<string, string> = {};
      if (params.contextId) {
        filter.contextId = params.contextId;
      }
      if (params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
        filter.state = String(params.status);
      }
      const query: QueryInput = {
        index: "GSI1",
        pk: keys.a2aTaskListPartition(projectName, scope),
        forward: false,
        notExpiredAt: Math.floor(Date.now() / 1000),
        ...(params.statusTimestampAfter
          ? { sk: { gte: `${new Date(Date.parse(params.statusTimestampAfter)).toISOString()}#` } }
          : {}),
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      };
      const [items, totalSize] = await Promise.all([
        queryItems({
          ...query,
          limit: pageSize + 1,
          ...(cursor
            ? {
                after: keys.a2aTaskList(projectName, scope, cursor.timestamp, cursor.id).GSI1SK,
              }
            : {}),
        }),
        countItems(query),
      ]);
      const page = items
        .slice(0, pageSize)
        .map((item) => fromStoredTask(item.task as Task));
      const tasks = page.map((task) => ({
        ...task,
        artifacts: params.includeArtifacts ? task.artifacts : [],
        history:
          params.historyLength === undefined
            ? task.history
            : params.historyLength === 0
              ? []
              : task.history.slice(-params.historyLength),
      }));
      const hasMore = items.length > pageSize;
      return {
        tasks,
        nextPageToken:
          hasMore && page.length > 0
            ? encodePageCursor(page[page.length - 1]!)
            : "",
        pageSize,
        totalSize,
      };
    },
  };
}

/** Project + tenant + authenticated caller is the task visibility boundary. */
function ownerScope(context: ServerCallContext): string {
  return `${context.tenant ?? ""}:${context.user?.userName || "anonymous"}`;
}

interface TaskPageCursor {
  timestamp: string;
  id: string;
}

function pageCursor(token: string): TaskPageCursor | undefined {
  if (!token) {
    return undefined;
  }
  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (
      value &&
      typeof value === "object" &&
      typeof (value as TaskPageCursor).timestamp === "string" &&
      typeof (value as TaskPageCursor).id === "string" &&
      (value as TaskPageCursor).id !== "" &&
      ((value as TaskPageCursor).timestamp === "" ||
        !Number.isNaN(Date.parse((value as TaskPageCursor).timestamp)))
    ) {
      return value as TaskPageCursor;
    }
  } catch {
    // The protocol error below is the public contract for every malformed token.
  }
  throw new RequestMalformedError("ListTasks pageToken is invalid.");
}

function encodePageCursor(task: Task): string {
  return Buffer.from(
    JSON.stringify({ timestamp: sortableTimestamp(task), id: task.id }),
    "utf8",
  ).toString("base64url");
}

function sortableTimestamp(task: Task): string {
  const timestamp = Date.parse(task.status?.timestamp ?? "");
  return Number.isNaN(timestamp) ? "" : new Date(timestamp).toISOString();
}

function validateListRequest(params: ListTasksRequest): void {
  if (params.pageToken) {
    // Validate before reading the store so an invalid request has no side effects.
    pageCursor(params.pageToken);
  }
  if (params.pageSize !== undefined && (params.pageSize < 1 || params.pageSize > 100)) {
    throw new RequestMalformedError("ListTasks pageSize must be between 1 and 100.");
  }
  if (params.historyLength !== undefined && params.historyLength < 0) {
    throw new RequestMalformedError("ListTasks historyLength must not be negative.");
  }
  if (
    params.status < TaskState.TASK_STATE_UNSPECIFIED ||
    params.status > TaskState.TASK_STATE_AUTH_REQUIRED
  ) {
    throw new RequestMalformedError("ListTasks status is invalid.");
  }
  if (params.statusTimestampAfter && Number.isNaN(Date.parse(params.statusTimestampAfter))) {
    throw new RequestMalformedError("ListTasks statusTimestampAfter must be an ISO 8601 timestamp.");
  }
}
