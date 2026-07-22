export interface Chat {
  chatId: string;
  title: string;
  ownerEmail: string;
  projectName?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatRole = "user" | "assistant" | "tool";

/** Generated image attached to an assistant message (uploaded to object storage). */
export interface ChatMessageImage {
  url: string;
  prompt?: string;
}

export interface ChatMessage {
  chatId: string;
  seq: number;
  role: ChatRole;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: unknown[];
  /** Present on tool messages. */
  toolCallId?: string;
  /** Present on tool messages: the tool that produced the result, for display. */
  toolName?: string;
  /** Present on assistant messages whose run generated images. */
  images?: ChatMessageImage[];
  createdAt: string;
}
