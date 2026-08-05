import { randomUUID } from "node:crypto";
import type { ChatRepository } from "@/domain/chat/repository";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { ChatConflictError, ChatNotFoundError } from "./errors";

export async function claimChatRun(chats: ChatRepository, chatId: string): Promise<string> {
  const runId = randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claimed = await chats.claimRun(
    chatId,
    runId,
    nowSeconds,
    nowSeconds + RUN_LEASE_SECONDS,
  );
  if (!claimed) {
    throw new ChatConflictError();
  }
  return runId;
}

/**
 * Whether `runId` still holds this chat — the question a reader asks after its
 * stream stopped without saying why.
 *
 * Two small reads: the chat row for the ownership check, and the claim on it.
 * `getChat` can answer the same question, but it resolves every message in the
 * conversation and signs a URL per stored image on the way — an expensive way to
 * compare one id, asked on the one path where the network is already known to be
 * bad.
 */
export async function isChatRunActive(
  chats: ChatRepository,
  chatId: string,
  runId: string,
  userEmail: string,
): Promise<boolean> {
  const chat = await chats.get(chatId);
  // Non-owner access is indistinguishable from missing, as everywhere a chat is
  // read.
  if (!chat || chat.ownerEmail !== userEmail) {
    throw new ChatNotFoundError();
  }
  const active = await chats.getActiveRun(chatId);
  return (
    active !== null && active.runId === runId && active.expiresAtSeconds * 1000 > Date.now()
  );
}
