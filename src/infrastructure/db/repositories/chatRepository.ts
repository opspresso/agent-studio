import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { expiresAtSeconds, isExpired, notExpired, RETENTION } from "@/infrastructure/db/ttl";
import type { ChatRepository } from "@/domain/chat/repository";
import type {
  Chat,
  ChatMessage,
  ChatMessageDocument,
  ChatMessageFile,
  ChatMessageImage,
  ChatRole,
} from "@/domain/chat/types";
import type { ChannelToolCall } from "@/domain/llm/types";

const CHAT_ENTITY = "Chat";
const MESSAGE_ENTITY = "ChatMessage";

type DynamoItem = Record<string, unknown>;
type LastKey = QueryCommandOutput["LastEvaluatedKey"];
type WriteRequests = NonNullable<BatchWriteCommandInput["RequestItems"]>[string];

function fromChatItem(item: DynamoItem): Chat {
  return {
    chatId: item.chatId as string,
    title: item.title as string,
    ownerEmail: item.ownerEmail as string,
    projectName: item.projectName as string | undefined,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

function chatUpdate(chat: Chat, condition: string): UpdateCommand {
  return new UpdateCommand({
    TableName: getTableName(),
    Key: keys.chat(chat.chatId),
    UpdateExpression:
      "SET GSI1PK = :gsi1pk, GSI1SK = :gsi1sk, entityType = :entityType, " +
      "chatId = :chatId, title = :title, ownerEmail = :ownerEmail, " +
      "projectName = :projectName, createdAt = :createdAt, updatedAt = :updatedAt, " +
      "expiresAt = :expiresAt, nextSeq = if_not_exists(nextSeq, :zero)",
    ExpressionAttributeValues: {
      ":gsi1pk": keys.chatOwnerPartition(chat.ownerEmail),
      ":gsi1sk": chat.updatedAt,
      ":entityType": CHAT_ENTITY,
      ":chatId": chat.chatId,
      ":title": chat.title,
      ":ownerEmail": chat.ownerEmail,
      ":projectName": chat.projectName ?? null,
      ":createdAt": chat.createdAt,
      ":updatedAt": chat.updatedAt,
      // Retention runs from last activity — each update pushes the expiry out,
      // so an active chat is never purged mid-run.
      ":expiresAt": expiresAtSeconds(chat.updatedAt, RETENTION.chatDays),
      ":zero": 0,
    },
    ConditionExpression: condition,
  });
}

function toMessageItem(message: ChatMessage) {
  const { PK, SK } = keys.chatMessage(message.chatId, message.seq);
  return {
    PK,
    SK,
    entityType: MESSAGE_ENTITY,
    ...message,
    expiresAt: expiresAtSeconds(message.createdAt, RETENTION.chatDays),
  };
}

function fromMessageItem(item: DynamoItem): ChatMessage {
  const base = {
    chatId: item.chatId as string,
    seq: item.seq as number,
    content: item.content as string,
    createdAt: item.createdAt as string,
  };
  const role = item.role as ChatRole;
  if (role === "tool") {
    return {
      ...base,
      role,
      toolCallId: item.toolCallId as string,
      toolName: item.toolName as string | undefined,
      author: item.author as string | undefined,
      displayOnly: item.displayOnly as boolean | undefined,
    };
  }
  if (role === "assistant") {
    return {
      ...base,
      role,
      toolCalls: item.toolCalls as ChannelToolCall[] | undefined,
      warnings: item.warnings as string[] | undefined,
      images: item.images as ChatMessageImage[] | undefined,
      // Same trap as the user turn below: the write spreads the whole message,
      // so a field missing *here* stores fine and reads back as nothing.
      files: item.files as ChatMessageFile[] | undefined,
    };
  }
  // A user turn carries what the user attached — images, and the text read out
  // of any documents. Reading them back is what makes an attachment survive a
  // reload; without it the write succeeds, the item holds them, and the chat
  // still shows nothing.
  return {
    ...base,
    role: "user",
    images: item.images as ChatMessageImage[] | undefined,
    documents: item.documents as ChatMessageDocument[] | undefined,
  };
}

export const chatRepository: ChatRepository = {
  async get(chatId) {
    const res = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.chat(chatId) }),
    );
    if (!res.Item || isExpired(res.Item.expiresAt, Date.now())) {
      return null;
    }
    return fromChatItem(res.Item);
  },

  async listByOwner(ownerEmail) {
    const client = getDocumentClient();
    const table = getTableName();
    const chats: Chat[] = [];
    let lastKey: LastKey;
    do {
      const res = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": keys.chatOwnerPartition(ownerEmail) },
          ScanIndexForward: false,
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of notExpired(res.Items ?? [], Date.now())) {
        chats.push(fromChatItem(item));
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return chats;
  },

  async create(chat) {
    await getDocumentClient().send(chatUpdate(chat, "attribute_not_exists(PK)"));
  },

  async update(chat) {
    await getDocumentClient().send(
      chatUpdate(chat, "attribute_exists(PK) AND attribute_not_exists(deletingAt)"),
    );
  },

  async delete(chatId) {
    const client = getDocumentClient();
    const table = getTableName();
    await client.send(
      new UpdateCommand({
        TableName: table,
        Key: keys.chat(chatId),
        UpdateExpression: "SET deletingAt = if_not_exists(deletingAt, :now)",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      }),
    );
    const toRemove: { PK: string; SK: string }[] = [];
    let lastKey: LastKey;
    do {
      const res = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": keys.chat(chatId).PK },
          ProjectionExpression: "PK, SK",
          ExclusiveStartKey: lastKey,
          ConsistentRead: true,
        }),
      );
      for (const item of res.Items ?? []) {
        if (item.SK !== "META") {
          toRemove.push({ PK: item.PK as string, SK: item.SK as string });
        }
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);

    for (let i = 0; i < toRemove.length; i += 25) {
      let pending: WriteRequests = toRemove
        .slice(i, i + 25)
        .map((Key) => ({ DeleteRequest: { Key } }));
      for (let attempt = 0; pending.length > 0 && attempt < 5; attempt += 1) {
        const res = await client.send(
          new BatchWriteCommand({ RequestItems: { [table]: pending } }),
        );
        pending = res.UnprocessedItems?.[table] ?? [];
      }
      if (pending.length > 0) {
        throw new Error(`Failed to delete all chat messages after 5 attempts (${pending.length} remain)`);
      }
    }
    await client.send(
      new DeleteCommand({
        TableName: table,
        Key: keys.chat(chatId),
        ConditionExpression: "attribute_exists(PK) AND attribute_exists(deletingAt)",
      }),
    );
  },

  async listMessages(chatId) {
    const client = getDocumentClient();
    const table = getTableName();
    const messages: ChatMessage[] = [];
    let lastKey: LastKey;
    do {
      const res = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: {
            ":pk": keys.chat(chatId).PK,
            ":sk": keys.chatMessagePrefix(),
          },
          ScanIndexForward: true,
          ExclusiveStartKey: lastKey,
          // The client refetches this list the moment a stream finishes; an
          // eventually-consistent read can miss the just-persisted assistant
          // message and make the answer vanish from the thread.
          ConsistentRead: true,
        }),
      );
      for (const item of notExpired(res.Items ?? [], Date.now())) {
        messages.push(fromMessageItem(item));
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return messages;
  },

  async appendMessage(message) {
    await getDocumentClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: getTableName(),
              Key: keys.chat(message.chatId),
              ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(deletingAt)",
            },
          },
          {
            Put: {
              TableName: getTableName(),
              Item: toMessageItem(message),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  },

  async claimRun(chatId, runId, nowSeconds, expiresAtSeconds) {
    try {
      await getDocumentClient().send(
        new UpdateCommand({
          TableName: getTableName(),
          Key: keys.chat(chatId),
          // The cancel flag is cleared with the claim: left behind by the
          // previous run, it would stop this one before it produced a token.
          UpdateExpression:
            "SET activeRunId = :runId, activeRunExpiresAt = :expiresAt REMOVE cancelRequestedAt",
          ConditionExpression:
            "attribute_exists(PK) AND attribute_not_exists(deletingAt) AND " +
            "(attribute_not_exists(activeRunId) OR activeRunExpiresAt < :now)",
          ExpressionAttributeValues: {
            ":runId": runId,
            ":now": nowSeconds,
            ":expiresAt": expiresAtSeconds,
          },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
        return false;
      }
      throw error;
    }
  },

  async releaseRun(chatId, runId) {
    try {
      await getDocumentClient().send(
        new UpdateCommand({
          TableName: getTableName(),
          Key: keys.chat(chatId),
          UpdateExpression: "REMOVE activeRunId, activeRunExpiresAt, cancelRequestedAt",
          ConditionExpression: "attribute_exists(PK) AND activeRunId = :runId",
          ExpressionAttributeValues: { ":runId": runId },
        }),
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") {
        throw error;
      }
    }
  },

  async getActiveRun(chatId) {
    const res = await getDocumentClient().send(
      new GetCommand({
        TableName: getTableName(),
        Key: keys.chat(chatId),
        ProjectionExpression: "activeRunId, activeRunExpiresAt, cancelRequestedAt",
        // The two readers of this both need an answer that is current: a run
        // polling for its own cancel, and a browser asking whether the run it
        // is about to attach to still exists. A tiny projection makes the
        // consistent read cheap enough not to trade one for the other.
        ConsistentRead: true,
      }),
    );
    const runId = res.Item?.activeRunId;
    if (typeof runId !== "string") {
      return null;
    }
    const cancelRequestedAt = res.Item?.cancelRequestedAt;
    return {
      runId,
      expiresAtSeconds: Number(res.Item?.activeRunExpiresAt ?? 0),
      ...(typeof cancelRequestedAt === "string" ? { cancelRequestedAt } : {}),
    };
  },

  async requestCancel(chatId, runId) {
    try {
      await getDocumentClient().send(
        new UpdateCommand({
          TableName: getTableName(),
          Key: keys.chat(chatId),
          UpdateExpression: "SET cancelRequestedAt = :now",
          // Scoped to the named run: a stop pressed on a run that has since
          // finished must not reach whatever the chat is doing now.
          ConditionExpression: "attribute_exists(PK) AND activeRunId = :runId",
          ExpressionAttributeValues: { ":runId": runId, ":now": new Date().toISOString() },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
        return false;
      }
      throw error;
    }
  },

  async reserveMessageSeq(chatId) {
    const client = getDocumentClient();
    const table = getTableName();
    const key = keys.chat(chatId);

    for (;;) {
      const meta = await client.send(
        new GetCommand({
          TableName: table,
          Key: key,
          ProjectionExpression: "nextSeq",
          ConsistentRead: true,
        }),
      );
      if (typeof meta.Item?.nextSeq !== "number") {
        const latest = await client.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues: {
              ":pk": key.PK,
              ":sk": keys.chatMessagePrefix(),
            },
            ProjectionExpression: "seq",
            ScanIndexForward: false,
            Limit: 1,
            ConsistentRead: true,
          }),
        );
        const initial = Number(latest.Items?.[0]?.seq ?? -1) + 1;
        try {
          await client.send(
            new UpdateCommand({
              TableName: table,
              Key: key,
              UpdateExpression: "SET nextSeq = :initial",
              ConditionExpression:
                "attribute_exists(PK) AND attribute_not_exists(deletingAt) AND attribute_not_exists(nextSeq)",
              ExpressionAttributeValues: { ":initial": initial },
            }),
          );
        } catch (error) {
          if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
            continue;
          }
          throw error;
        }
      }

      const reserved = await client.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: "ADD nextSeq :one",
          ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(deletingAt)",
          ExpressionAttributeValues: { ":one": 1 },
          ReturnValues: "UPDATED_OLD",
        }),
      );
      return Number(reserved.Attributes?.nextSeq ?? 0);
    }
  },
};
