/**
 * DynamoDB-backed A2A task store. Replaces the SDK's in-memory store so inbound
 * A2A task state (`message/send` → `tasks/get`/`tasks/cancel`) survives instance
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

import type { Message, Part, Task } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { RETENTION, expiresAtSeconds, isExpired } from "@/infrastructure/db/ttl";

/** States a task never transitions away from; a stored one must not be regressed. */
const TERMINAL_STATES = ["completed", "canceled", "failed", "rejected"] as const;

/**
 * Headroom under the 400KB DynamoDB item limit, measured against the whole
 * stored item. When a task exceeds it, {@link fitTask} degrades the payload in
 * steps — drop inline file bytes, then drop history/artifacts — so the task's
 * state and metadata always stay retrievable rather than failing the write.
 */
const MAX_ITEM_BYTES = 350_000;

function stripPartBytes(parts: Part[] | undefined): Part[] | undefined {
  return parts?.map((part) =>
    part.kind === "file" && "bytes" in part.file && part.file.bytes
      ? { ...part, file: { ...part.file, bytes: "" } }
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
 * the item fits and `tasks/get` still resolves. */
function dropBulkParts(task: Task): Task {
  return { ...task, history: undefined, artifacts: undefined };
}

/**
 * Pick the largest representation whose FULL stored item fits under
 * {@link MAX_ITEM_BYTES}: whole → without inline file bytes → without history and
 * artifacts. The last form is returned even if still over (best effort), because
 * a retrievable state beats a rejected write.
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
  return dropBulkParts(task);
}

/** A DynamoDB {@link TaskStore} scoped to a single project. */
export function createA2aTaskStore(projectName: string): TaskStore {
  return {
    async load(taskId: string): Promise<Task | undefined> {
      const result = await getDocumentClient().send(
        new GetCommand({
          TableName: getTableName(),
          Key: keys.a2aTask(projectName, taskId),
        }),
      );
      const item = result.Item;
      if (!item || isExpired(item.expiresAt, Date.now())) {
        return undefined;
      }
      return item.task as Task;
    },

    async save(task: Task): Promise<void> {
      const now = new Date().toISOString();
      const wrapper = {
        ...keys.a2aTask(projectName, task.id),
        entityType: "a2aTask",
        projectName,
        taskId: task.id,
        state: task.status.state,
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
  };
}
