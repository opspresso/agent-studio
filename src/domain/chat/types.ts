import type { ChannelToolCall } from "../llm/types";

export interface Chat {
  chatId: string;
  title: string;
  ownerEmail: string;
  projectName?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatRole = "user" | "assistant" | "tool";

/**
 * An image attached to a message, uploaded to object storage — a picture the run
 * generated, or one the user sent. Only the URL is stored; a b64 payload is far
 * beyond the item size limit.
 */
export interface ChatMessageImage {
  url: string;
  prompt?: string;
}

interface ChatMessageBase {
  chatId: string;
  seq: number;
  content: string;
  createdAt: string;
}

export interface UserChatMessage extends ChatMessageBase {
  role: "user";
  /** Present when the user attached images to the turn. */
  images?: ChatMessageImage[];
}

export interface AssistantChatMessage extends ChatMessageBase {
  role: "assistant";
  /** Present when the turn requested tool calls (persisted for display only). */
  toolCalls?: ChannelToolCall[];
  /** Present when the run generated images. */
  images?: ChatMessageImage[];
}

export interface ToolChatMessage extends ChatMessageBase {
  role: "tool";
  /** Ties the result to an assistant tool call; unmatched rows are display-only. */
  toolCallId: string;
  /** The tool that produced the result, for display. */
  toolName?: string;
}

/**
 * Discriminated on `role` so illegal states (a tool row without a call id, an
 * assistant with one) are unrepresentable.
 */
export type ChatMessage = UserChatMessage | AssistantChatMessage | ToolChatMessage;
