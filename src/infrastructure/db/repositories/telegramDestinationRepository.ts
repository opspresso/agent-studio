import type {
  TelegramDestination,
  TelegramDestinationRepository,
} from "@/domain/telegram/destination";
import { keys } from "@/infrastructure/db/keys";
import { queryItems } from "@/infrastructure/db/store";
import { putProjectItem } from "@/infrastructure/db/projectLifecycle";

function fromItem(item: Record<string, unknown>): TelegramDestination {
  if (
    typeof item.chatId !== "number" ||
    typeof item.chatType !== "string" ||
    !["private", "group", "supergroup", "channel"].includes(item.chatType) ||
    typeof item.title !== "string" ||
    typeof item.lastSeenAt !== "string"
  ) {
    throw new Error("Stored Telegram destination is invalid");
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
    await putProjectItem(projectName, {
      ...keys.telegramDestination(projectName, botId, destination.chatId, destination.threadId),
      ...keys.telegramDestinationIndexPrefix(projectName, botId),
      GSI2SK: destination.lastSeenAt,
      entityType: "telegramDestination",
      projectName,
      botId,
      ...destination,
    });
  },

  async list(projectName, botId, limit) {
    const index = keys.telegramDestinationIndexPrefix(projectName, botId);
    const items = await queryItems({
      index: "GSI2",
      pk: index.GSI2PK,
      forward: false,
      limit,
    });
    return items.map(fromItem);
  },
};
