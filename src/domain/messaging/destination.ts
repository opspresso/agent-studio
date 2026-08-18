/** A configured place where application-owned notifications are sent. */
export type MessageDestination =
  | { kind: "slack"; channelId: string }
  | { kind: "telegram"; chatId: number; threadId?: number }
  | { kind: "teams"; conversationId: string };

export type MessageDestinationKind = MessageDestination["kind"];
