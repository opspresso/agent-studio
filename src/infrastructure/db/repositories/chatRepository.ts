import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import type { ChatRepository } from "@/domain/chat/repository";
import type { Chat, ChatMessage, ChatMessageImage, ChatRole } from "@/domain/chat/types";

const CHAT_ENTITY = "Chat";
const MESSAGE_ENTITY = "ChatMessage";

type DynamoItem = Record<string, unknown>;
type LastKey = QueryCommandOutput["LastEvaluatedKey"];
type WriteRequests = NonNullable<BatchWriteCommandInput["RequestItems"]>[string];

function toChatItem(chat: Chat) {
  const { PK, SK } = keys.chat(chat.chatId);
  return {
    PK,
    SK,
    GSI1PK: keys.chatOwnerPartition(chat.ownerEmail),
    GSI1SK: chat.updatedAt,
    entityType: CHAT_ENTITY,
    ...chat,
  };
}

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

function toMessageItem(message: ChatMessage) {
  const { PK, SK } = keys.chatMessage(message.chatId, message.seq);
  return { PK, SK, entityType: MESSAGE_ENTITY, ...message };
}

function fromMessageItem(item: DynamoItem): ChatMessage {
  return {
    chatId: item.chatId as string,
    seq: item.seq as number,
    role: item.role as ChatRole,
    content: item.content as string,
    toolCalls: item.toolCalls as unknown[] | undefined,
    toolCallId: item.toolCallId as string | undefined,
    toolName: item.toolName as string | undefined,
    images: item.images as ChatMessageImage[] | undefined,
    createdAt: item.createdAt as string,
  };
}

export const chatRepository: ChatRepository = {
  async get(chatId) {
    const res = await getDocumentClient().send(
      new GetCommand({ TableName: getTableName(), Key: keys.chat(chatId) }),
    );
    return res.Item ? fromChatItem(res.Item) : null;
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
      for (const item of res.Items ?? []) {
        chats.push(fromChatItem(item));
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return chats;
  },

  async put(chat) {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: toChatItem(chat) }),
    );
  },

  async delete(chatId) {
    const client = getDocumentClient();
    const table = getTableName();
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
        }),
      );
      for (const item of res.Items ?? []) {
        toRemove.push({ PK: item.PK as string, SK: item.SK as string });
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);

    for (let i = 0; i < toRemove.length; i += 25) {
      let pending: WriteRequests = toRemove
        .slice(i, i + 25)
        .map((Key) => ({ DeleteRequest: { Key } }));
      while (pending.length > 0) {
        const res = await client.send(
          new BatchWriteCommand({ RequestItems: { [table]: pending } }),
        );
        pending = res.UnprocessedItems?.[table] ?? [];
      }
    }
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
        }),
      );
      for (const item of res.Items ?? []) {
        messages.push(fromMessageItem(item));
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return messages;
  },

  async appendMessage(message) {
    await getDocumentClient().send(
      new PutCommand({ TableName: getTableName(), Item: toMessageItem(message) }),
    );
  },
};
