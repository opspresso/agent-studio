export interface Chat {
  chatId: string;
  title: string;
  ownerEmail: string;
  projectName?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatRole = "user" | "assistant" | "tool";

export interface ChatMessage {
  chatId: string;
  seq: number;
  role: ChatRole;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: unknown[];
  /** Present on tool messages. */
  toolCallId?: string;
  createdAt: string;
}
