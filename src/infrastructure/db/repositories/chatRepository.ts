import { keys } from "@/infrastructure/db/keys";
import {
  CONDITIONAL_WRITE_FAILED,
  conditions,
  deleteItem,
  deletePartition,
  getItem,
  queryItems,
  updateItem,
  type Item,
} from "@/infrastructure/db/store";
import { chatActivityFields, chatIsLive, putChatItem } from "@/infrastructure/db/chatLifecycle";
import { expiresAtSeconds, isExpired, RETENTION } from "@/infrastructure/db/ttl";
import { CHAT_PAGE, MAX_CHAT_PAGE, type ChatRepository } from "@/domain/chat/repository";
import { boundedPageLimit, MAX_PAGE_LIMIT } from "@/shared/pageLimit";
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

function lostCondition(error: unknown): boolean {
  return error instanceof Error && error.name === CONDITIONAL_WRITE_FAILED;
}

function fromChatItem(item: Item): Chat {
  return {
    chatId: item.chatId as string,
    title: item.title as string,
    ownerEmail: item.ownerEmail as string,
    agentName: item.agentName as string | undefined,
    workspaceId: item.workspaceId as string | undefined,
    linkedWorkspaces: item.linkedWorkspaces as Chat["linkedWorkspaces"],
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

/**
 * The chat's own fields written over whatever else the row carries — the run
 * lease, the sequence counter, a deletion mark are the run's and survive.
 */
function chatFields(chat: Chat): Item {
  return {
    GSI1PK: keys.chatOwnerPartition(chat.ownerEmail),
    ...chatActivityFields(chat.updatedAt),
    entityType: CHAT_ENTITY,
    chatId: chat.chatId,
    title: chat.title,
    ownerEmail: chat.ownerEmail,
    agentName: chat.agentName ?? null,
    createdAt: chat.createdAt,
  };
}

export function chatCreationItem(chat: Chat): Item {
  return { ...keys.chat(chat.chatId), ...chatFields(chat), nextSeq: 0, ...(chat.workspaceId ? { workspaceId: chat.workspaceId } : {}) };
}

export function chatMessageItem(message: ChatMessage): Item {
  const { PK, SK } = keys.chatMessage(message.chatId, message.seq);
  return {
    PK,
    SK,
    entityType: MESSAGE_ENTITY,
    ...message,
    expiresAt: expiresAtSeconds(message.createdAt, RETENTION.chatDays),
  };
}

function fromMessageItem(item: Item): ChatMessage {
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
      workspaceAction: item.workspaceAction as Extract<ChatMessage, { role: "assistant" }>["workspaceAction"],
      toolCalls: item.toolCalls as ChannelToolCall[] | undefined,
      warnings: item.warnings as string[] | undefined,
      images: item.images as ChatMessageImage[] | undefined,
      // Same trap as the user turn below: the write spreads the whole message,
      // so a field missing *here* stores fine and reads back as nothing.
      files: item.files as ChatMessageFile[] | undefined,
      reasoning: item.reasoning as string | undefined,
      reasoningTokens: item.reasoningTokens as number | undefined,
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
    const item = await getItem(keys.chat(chatId));
    if (!item || isExpired(item.expiresAt, Date.now())) {
      return null;
    }
    return fromChatItem(item);
  },

  async listByOwner(ownerEmail, options = {}) {
    const items = await queryItems({
      index: "GSI1",
      pk: keys.chatOwnerPartition(ownerEmail),
      forward: false,
      limit: boundedPageLimit(options.limit ?? CHAT_PAGE, MAX_CHAT_PAGE),
      notExpiredAt: Math.floor(Date.now() / 1000),
      ...(options.kind ? { attributePresence: { attribute: "workspaceId", exists: options.kind === "workspace" } } : {}),
    });
    return items.map(fromChatItem);
  },

  async create(chat) {
    await updateItem(
      keys.chat(chat.chatId),
      () => chatCreationItem(chat),
      conditions.notExists,
    );
  },

  async update(chat) {
    await updateItem(
      keys.chat(chat.chatId),
      (row) => ({ ...row, ...chatFields(chat), nextSeq: row?.nextSeq ?? 0 }),
      chatIsLive,
    );
  },

  async delete(chatId) {
    await updateItem(
      keys.chat(chatId),
      (row) => ({ ...row, deletingAt: row?.deletingAt ?? new Date().toISOString() }),
      conditions.exists,
    );
    await deletePartition(keys.chat(chatId).PK, { keep: [keys.chat(chatId).SK] });
    await deleteItem(keys.chat(chatId), (row) => row !== null && row.deletingAt !== undefined);
  },

  async listMessages(chatId, options = {}) {
    const { sinceSeq } = options;
    // Past `sinceSeq` the query is a range rather than the prefix — the bounds
    // come from `keys` either way, and `chatMessageRange` says why the upper
    // one has to be there. It answers `null` for a sequence past the last one
    // a key can hold, which is an empty tail and not a query to run.
    if (sinceSeq !== undefined && keys.chatMessageRange(sinceSeq + 1) === null) {
      return [];
    }
    const range = sinceSeq === undefined ? null : keys.chatMessageRange(sinceSeq + 1);
    const items = await queryItems({
      pk: keys.chat(chatId).PK,
      sk: range ? { between: [range.from, range.to] } : { prefix: keys.chatMessagePrefix() },
      limit: boundedPageLimit(options.limit ?? MAX_PAGE_LIMIT),
      notExpiredAt: Math.floor(Date.now() / 1000),
    });
    return items.map((item) => {
      const message = fromMessageItem(item);
      if (keys.chatMessage(chatId, message.seq).SK !== item.SK) {
        throw new Error("chat message identity does not match its key");
      }
      return message;
    });
  },

  async appendMessage(message) {
    await putChatItem(message.chatId, chatMessageItem(message), conditions.notExists);
  },

  async claimRun(chatId, runId, nowSeconds, expiresAtSeconds) {
    try {
      await updateItem(
        keys.chat(chatId),
        (row) => {
          // The cancel flag is cleared with the claim: left behind by the
          // previous run, it would stop this one before it produced a token.
          const { cancelRequestedAt: _cleared, ...rest } = row ?? {};
          void _cleared;
          return { ...rest, activeRunId: runId, activeRunExpiresAt: expiresAtSeconds };
        },
        (row) =>
          chatIsLive(row) &&
          row?.workspaceId === undefined &&
          (row?.activeRunId === undefined || Number(row?.activeRunExpiresAt ?? 0) < nowSeconds),
      );
      return true;
    } catch (error) {
      if (lostCondition(error)) {
        return false;
      }
      throw error;
    }
  },

  async releaseRun(chatId, runId) {
    try {
      await updateItem(
        keys.chat(chatId),
        (row) => {
          const { activeRunId: _id, activeRunExpiresAt: _exp, cancelRequestedAt: _cancel, ...rest } =
            row ?? {};
          void _id, _exp, _cancel;
          return rest;
        },
        conditions.existsWith("activeRunId", runId),
      );
    } catch (error) {
      if (!lostCondition(error)) {
        throw error;
      }
    }
  },

  async getActiveRun(chatId) {
    const item = await getItem(keys.chat(chatId));
    const runId = item?.activeRunId;
    if (typeof runId !== "string") {
      return null;
    }
    const cancelRequestedAt = item?.cancelRequestedAt;
    return {
      runId,
      expiresAtSeconds: Number(item?.activeRunExpiresAt ?? 0),
      ...(typeof cancelRequestedAt === "string" ? { cancelRequestedAt } : {}),
    };
  },

  async requestCancel(chatId, runId) {
    try {
      await updateItem(
        keys.chat(chatId),
        (row) => ({ ...row, cancelRequestedAt: new Date().toISOString() }),
        // Scoped to the named run: a stop pressed on a run that has since
        // finished must not reach whatever the chat is doing now.
        conditions.existsWith("activeRunId", runId),
      );
      return true;
    } catch (error) {
      if (lostCondition(error)) {
        return false;
      }
      throw error;
    }
  },

  async reserveMessageSeq(chatId) {
    const key = keys.chat(chatId);
    // Taken under the row lock every caller competes on, so two reservations
    // never answer the same number. A row written before the counter existed
    // has none; it is initialised from the newest message — read only in that
    // case, since every chat created since carries the counter — and the
    // reservation retried, because another caller may have initialised it
    // meanwhile and this one must count from what they wrote.
    for (;;) {
      const { before } = await updateItem(
        key,
        (row) => (typeof row?.nextSeq === "number" ? { ...row, nextSeq: row.nextSeq + 1 } : { ...row }),
        chatIsLive,
      );
      if (typeof before?.nextSeq === "number") {
        return before.nextSeq;
      }
      const latest = await queryItems({
        pk: key.PK,
        sk: { prefix: keys.chatMessagePrefix() },
        forward: false,
        limit: 1,
      });
      const initial = Number(latest[0]?.seq ?? -1) + 1;
      await updateItem(
        key,
        (row) => ({ ...row, nextSeq: initial }),
        (row) => chatIsLive(row) && row?.nextSeq === undefined,
      ).catch((error: unknown) => {
        // Someone else initialised it first; the retry counts from theirs.
        if (!lostCondition(error)) {
          throw error;
        }
      });
    }
  },
};
