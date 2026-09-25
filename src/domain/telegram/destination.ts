export interface TelegramDestination {
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  title: string;
  threadId?: number;
  lastSeenAt: string;
}

export interface TelegramDestinationRepository {
  put(
    agentName: string,
    botId: number | string,
    destination: TelegramDestination,
  ): Promise<void>;
  list(
    agentName: string,
    botId: number | string,
    limit: number,
  ): Promise<TelegramDestination[]>;
}
