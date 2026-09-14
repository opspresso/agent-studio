import { keys } from "./keys";
import { transact, type Condition, type Item } from "./store";
import { expiresAtSeconds, RETENTION } from "./ttl";

export const chatIsLive: Condition = (row) => row !== null && row.deletingAt === undefined;

export function chatActivityFields(updatedAt: string): Item {
  return { updatedAt, GSI1SK: updatedAt, expiresAt: expiresAtSeconds(updatedAt, RETENTION.chatDays) };
}

/** Keep child writes inside the same lifecycle fence as chat deletion. */
export async function putChatItem(chatId: string, item: Item, condition?: Condition): Promise<void> {
  await transact([
    { kind: "check", key: keys.chat(chatId), condition: chatIsLive },
    { kind: "put", item, ...(condition ? { condition } : {}) },
  ]);
}
