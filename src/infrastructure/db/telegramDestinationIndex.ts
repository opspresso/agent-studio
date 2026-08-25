import { keys } from "./keys";

/** Add the sparse recency index to a destination row from an older store export. */
export function withTelegramDestinationIndex(
  item: Record<string, unknown>,
): Record<string, unknown> {
  if (
    item.entityType !== "telegramDestination" ||
    typeof item.projectName !== "string" ||
    (typeof item.botId !== "number" && typeof item.botId !== "string") ||
    typeof item.lastSeenAt !== "string"
  ) {
    return item;
  }
  return {
    ...item,
    ...keys.telegramDestinationIndexPrefix(item.projectName, item.botId),
    GSI2SK: item.lastSeenAt,
  };
}
