import type {
  TelegramDestination,
  TelegramDestinationRepository,
} from "@/domain/telegram/destination";
import { keys } from "@/infrastructure/db/keys";
import { putItem, queryItems } from "@/infrastructure/db/store";

function fromItem(item: Record<string, unknown>): TelegramDestination | null {
  if (
    typeof item.chatId !== "number" ||
    typeof item.chatType !== "string" ||
    !["private", "group", "supergroup", "channel"].includes(item.chatType) ||
    typeof item.title !== "string" ||
    typeof item.lastSeenAt !== "string"
  ) {
    return null;
  }
  return {
    chatId: item.chatId,
    chatType: item.chatType as TelegramDestination["chatType"],
    title: item.title,
    ...(typeof item.threadId === "number" ? { threadId: item.threadId } : {}),
    lastSeenAt: item.lastSeenAt,
  };
}

export const telegramDestinationRepository: TelegramDestinationRepository = {
  async put(projectName, botId, destination) {
    await putItem({
      ...keys.telegramDestination(projectName, botId, destination.chatId, destination.threadId),
      entityType: "telegramDestination",
      projectName,
      botId,
      ...destination,
    });
  },

  async list(projectName, botId) {
    const key = keys.telegramDestinationPrefix(projectName, botId);
    const items = await queryItems({ pk: key.PK, sk: { prefix: key.prefix } });
    return items
      .flatMap((item): TelegramDestination[] => {
        const destination = fromItem(item);
        return destination ? [destination] : [];
      })
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  },
};
