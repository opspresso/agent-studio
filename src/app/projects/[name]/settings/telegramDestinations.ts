import type { TelegramDestinationInfo } from "../../lib/api";

export function telegramDestinationValue(
  destination: Pick<TelegramDestinationInfo, "chatId" | "threadId">,
): string {
  return `${destination.chatId}:${destination.threadId ?? ""}`;
}

export function telegramDestinationLabel(destination: TelegramDestinationInfo): string {
  const topic = destination.threadId === undefined ? "" : ` · topic ${destination.threadId}`;
  return `${destination.title}${topic} · ${destination.chatId}`;
}

export function findTelegramDestination(
  destinations: readonly TelegramDestinationInfo[],
  value: string | null,
): TelegramDestinationInfo | undefined {
  return destinations.find((destination) => telegramDestinationValue(destination) === value);
}
