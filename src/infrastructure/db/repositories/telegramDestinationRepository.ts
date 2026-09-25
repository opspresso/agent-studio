import type {
  TelegramDestination,
  TelegramDestinationRepository,
} from "@/domain/telegram/destination";
import { keys } from "@/infrastructure/db/keys";
import { queryItems } from "@/infrastructure/db/store";
import { putAgentItem } from "@/infrastructure/db/agentLifecycle";

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
  async put(agentName, botId, destination) {
    await putAgentItem(agentName, {
      ...keys.telegramDestination(agentName, botId, destination.chatId, destination.threadId),
      ...keys.telegramDestinationIndexPrefix(agentName, botId),
      GSI2SK: destination.lastSeenAt,
      entityType: "telegramDestination",
      agentName,
      botId,
      ...destination,
    });
  },

  async list(agentName, botId, limit) {
    const index = keys.telegramDestinationIndexPrefix(agentName, botId);
    const items = await queryItems({
      index: "GSI2",
      pk: index.GSI2PK,
      forward: false,
      limit,
    });
    return items.map(fromItem);
  },
};
