/**
 * DynamoDB-backed A2A task store. Replaces the SDK's in-memory store so inbound
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
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { RETENTION, expiresAtSeconds, isExpired } from "@/infrastructure/db/ttl";
import { queryAll } from "@/infrastructure/db/query";

import { A2A_TERMINAL_STATES as TERMINAL_STATES } from "@/domain/a2a/task";

/**
 * Headroom under the 400KB DynamoDB item limit, measured against the whole
 * stored item. When a task exceeds it, {@link fitTask} degrades the payload in
 * steps — drop inline file bytes, then drop history/artifacts — so the task's
 * state and metadata always stay retrievable rather than failing the write.
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

/** A DynamoDB {@link TaskStore} scoped to a single project. */
export function createA2aTaskStore(projectName: string): TaskStore {
  return {
    async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
      const result = await getDocumentClient().send(
        new GetCommand({
          TableName: getTableName(),
          Key: keys.a2aTask(projectName, ownerScope(context), taskId),
        }),
      );
      const item = result.Item;
      if (!item || isExpired(item.expiresAt, Date.now())) {
        return undefined;
      }
      return item.task as Task;
    },

    async save(task: Task, context: ServerCallContext): Promise<void> {
      const now = new Date().toISOString();
      const wrapper = {
        ...keys.a2aTask(projectName, ownerScope(context), task.id),
        entityType: "a2aTask",
        projectName,
        ownerScope: ownerScope(context),
        taskId: task.id,
        state: task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
        updatedAt: now,
        expiresAt: expiresAtSeconds(now, RETENTION.a2aTaskDays),
      };
      try {
        await getDocumentClient().send(
          new PutCommand({
            TableName: getTableName(),
            Item: { ...wrapper, task: fitTask(task, wrapper) },
            ConditionExpression:
              "attribute_not_exists(PK) OR NOT (#state IN (:s0, :s1, :s2, :s3))",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: {
              ":s0": TERMINAL_STATES[0],
              ":s1": TERMINAL_STATES[1],
              ":s2": TERMINAL_STATES[2],
              ":s3": TERMINAL_STATES[3],
            },
          }),
        );
      } catch (error) {
        // Losing side of a complete/cancel race: the stored terminal state wins,
        // so this write is a no-op. Any other failure propagates.
        if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
          return;
        }
        throw error;
      }
    },

    async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
      validateListRequest(params);
      const partition = keys.a2aTask(projectName, ownerScope(context), "").PK;
      const now = Date.now();
      const items = await queryAll({
        TableName: getTableName(),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :task)",
        ExpressionAttributeValues: { ":pk": partition, ":task": "TASK#" },
        ConsistentRead: true,
      });
      const statusTimestampAfter = params.statusTimestampAfter
        ? Date.parse(params.statusTimestampAfter)
        : undefined;
      const matching = items
        .filter((item) => !isExpired(item.expiresAt, now))
        .map((item) => item.task as Task)
        .filter((task) => !params.contextId || task.contextId === params.contextId)
        .filter(
          (task) =>
            params.status === TaskState.TASK_STATE_UNSPECIFIED || task.status?.state === params.status,
        )
        .filter(
          (task) =>
            statusTimestampAfter === undefined ||
            Date.parse(task.status?.timestamp ?? "") >= statusTimestampAfter,
        )
        .sort(compareTasks);
      const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 50));
      const cursor = pageCursor(params.pageToken);
      const remaining = cursor
        ? matching.filter((task) => isAfterCursor(task, cursor))
        : matching;
      const page = remaining.slice(0, pageSize);
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
      const hasMore = remaining.length > page.length;
      return {
        tasks,
        nextPageToken:
          hasMore && page.length > 0
            ? encodePageCursor(page[page.length - 1]!)
            : "",
        pageSize,
        totalSize: matching.length,
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
    JSON.stringify({ timestamp: task.status?.timestamp ?? "", id: task.id }),
    "utf8",
  ).toString("base64url");
}

/** Timestamp descending, then id descending so equal timestamps are stable. */
function compareTasks(a: Task, b: Task): number {
  const byTimestamp = (b.status?.timestamp ?? "").localeCompare(a.status?.timestamp ?? "");
  return byTimestamp || b.id.localeCompare(a.id);
}

function isAfterCursor(task: Task, cursor: TaskPageCursor): boolean {
  const timestamp = task.status?.timestamp ?? "";
  if (timestamp !== cursor.timestamp) {
    return timestamp < cursor.timestamp;
  }
  return task.id < cursor.id;
}

function validateListRequest(params: ListTasksRequest): void {
  if (params.pageToken) {
    // Validate before reading DynamoDB so an invalid request has no side effects.
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
