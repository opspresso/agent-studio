import { keys } from "@/infrastructure/db/keys";
import { queryItems } from "@/infrastructure/db/store";
import { putChatItem } from "@/infrastructure/db/chatLifecycle";
import { expiresAtFromNow, RUN_LOG_TTL_SECONDS } from "@/infrastructure/db/ttl";
import type { ChatRunLogRepository, RunLogEntry } from "@/domain/chat/runLog";
import { boundedPageLimit, MAX_PAGE_LIMIT } from "@/shared/pageLimit";

const ENTITY = "ChatRunLog";

/**
 * The replay log lives in the chat's own partition, so `chatRepository.delete`'s
 * cascade (everything but `META`) sweeps it without knowing it exists — a chat
 * deleted mid-run leaves no rows behind.
 */
export const chatRunLogRepository: ChatRunLogRepository = {
  async append(chatId, runId, entries) {
    // Sequential fenced writes: one flush is a handful of rows at most — the
    // frames are already batched into them.
    for (const entry of entries) {
      await putChatItem(chatId, {
        ...keys.chatRunLog(chatId, runId, entry.seq),
        entityType: ENTITY,
        chatId,
        runId,
        seq: entry.seq,
        payload: entry.payload,
        ...(entry.terminal ? { terminal: true } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        expiresAt: expiresAtFromNow(RUN_LOG_TTL_SECONDS),
      });
    }
  },

  async read(chatId, runId, fromSeq, limit) {
    const range = keys.chatRunLogRange(runId, fromSeq);
    const items = await queryItems({
      pk: keys.chatRunLog(chatId, runId, 0).PK,
      sk: { between: [range.from, range.to] },
      notExpiredAt: Math.floor(Date.now() / 1000),
      limit: boundedPageLimit(limit ?? MAX_PAGE_LIMIT),
    });
    return items.map(
      (item): RunLogEntry => ({
        seq: Number(item.seq),
        payload: String(item.payload ?? "[]"),
        ...(item.terminal === true ? { terminal: true as const } : {}),
        ...(typeof item.error === "string" ? { error: item.error } : {}),
      }),
    );
  },
};
