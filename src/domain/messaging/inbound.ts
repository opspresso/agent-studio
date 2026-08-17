import type { ChatMessageInput } from "@/domain/llm/types";

/**
 * What a messaging surface received, in the shape the shared turn pipeline
 * reads. An adapter builds these from its own event; the pipeline never sees
 * the platform's payload.
 */

/** An attachment on an inbound message. */
export interface InboundAttachment {
  /** What the reader called it — shown back in every warning about it. */
  name: string;
  /** The declared media type; empty when the platform gave none. */
  mimeType: string;
  /** The declared size, which a platform is free to omit. */
  size?: number;
  /**
   * Fetch the bytes, bounded *while they are read*. Absent when the platform
   * handed no address for them — reported as such rather than as a failed read.
   */
  download?: (maxBytes: number) => Promise<Buffer>;
}

/** One earlier turn of the conversation: the engine message plus what it carried. */
export interface HistoryTurn {
  message: ChatMessageInput;
  attachments: InboundAttachment[];
  /** The human who wrote it, when one did. Absent on the bot's own turns. */
  userId?: string;
}
