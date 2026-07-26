import { randomUUID } from "node:crypto";
import type { ChatRepository } from "@/domain/chat/repository";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { ChatConflictError } from "./errors";

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
