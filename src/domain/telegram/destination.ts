export interface TelegramDestination {
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  title: string;
  threadId?: number;
  lastSeenAt: string;
}

export interface TelegramDestinationRepository {
  put(
    projectName: string,
    botId: number | string,
    destination: TelegramDestination,
  ): Promise<void>;
  list(projectName: string, botId: number | string): Promise<TelegramDestination[]>;
}
