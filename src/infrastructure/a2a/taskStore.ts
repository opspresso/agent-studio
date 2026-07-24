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
 * Headroom under the 400KB DynamoDB item limit. When a task exceeds it, inline
 * file bytes (e.g. a generated image already streamed to the client) are dropped
 * so the task's state and metadata stay retrievable.
 */
const MAX_ITEM_BYTES = 350_000;

function stripPartBytes(parts: Part[] | undefined): Part[] | undefined {
  return parts?.map((part) =>
    part.kind === "file" && "bytes" in part.file && part.file.bytes
      ? { ...part, file: { ...part.file, bytes: "" } }
      : part,
  );
}

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

function serializeForStorage(task: Task): Task {
  if (Buffer.byteLength(JSON.stringify(task), "utf8") <= MAX_ITEM_BYTES) {
    return task;
  }
  return stripFileBytes(task);
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
      try {
        await getDocumentClient().send(
          new PutCommand({
            TableName: getTableName(),
            Item: {
              ...keys.a2aTask(projectName, task.id),
              entityType: "a2aTask",
              projectName,
              taskId: task.id,
              state: task.status.state,
              task: serializeForStorage(task),
              updatedAt: now,
              expiresAt: expiresAtSeconds(now, RETENTION.a2aTaskDays),
            },
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
