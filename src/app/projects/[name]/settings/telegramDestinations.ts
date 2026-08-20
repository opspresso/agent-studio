import type { TelegramDestination } from "../../lib/api";

export function telegramDestinationValue(
  destination: Pick<TelegramDestination, "chatId" | "threadId">,
): string {
  return `${destination.chatId}:${destination.threadId ?? ""}`;
}

export function telegramDestinationLabel(destination: TelegramDestination): string {
  const topic = destination.threadId === undefined ? "" : ` · topic ${destination.threadId}`;
  return `${destination.title}${topic} · ${destination.chatId}`;
}

export function findTelegramDestination(
  destinations: readonly TelegramDestination[],
  value: string | null,
): TelegramDestination | undefined {
  return destinations.find((destination) => telegramDestinationValue(destination) === value);
}
