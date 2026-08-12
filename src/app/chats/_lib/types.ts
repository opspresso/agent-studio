import type { Chat, ChatMessage } from "@/domain/chat/types";

export type { Chat, ChatMessage };

/** A single SSE frame from a chat stream. */
export interface StreamChunk {
  chat?: Chat;
  /** Head frame: the run this stream is carrying, for reattaching or stopping it. */
  runId?: string;
  /** Head frame: where the user's turn landed, so a mid-run arrival does not draw it twice. */
  userSeq?: number;
  /**
   * Trailing frame: the *run* is over, as opposed to the connection. A closed
   * body says nothing about which of the two happened.
   */
  ended?: boolean;
  delta?: { content?: string; toolCalls?: unknown[] };
  toolResult?: unknown;
  image?: { b64: string; mimeType: string; prompt?: string };
  /**
   * A file the run produced. No `b64`: the bytes are stripped once stored, so
   * what arrives is the reference — and the address to fetch it by is signed
   * when the finished turn is read back, not here.
   */
  file?: { name: string; mimeType: string; byteSize?: number; key?: string };
  author?: string;
  /** Transfer chain that produced the chunk, outermost first. */
  authorPath?: string[];
  /** This authored run returned and is no longer active. */
  authorDone?: boolean;
  /** A binding the run could not use; the run still answers. */
  warning?: string;
  error?: string;
}

export interface LiveToolCall {
  /** The provider's call id. What its result is matched back to. */
  id?: string | undefined;
  /** As the engine named it — see `parseWireToolCall` on why it is not decorated. */
  name: string;
  args: string;
}

export interface LiveToolResult {
  /** The call this answers. Absent only for a result nothing declared. */
  id?: string | undefined;
  name?: string | undefined;
  content: string;
}

export interface LiveImage {
  b64: string;
  mimeType: string;
  prompt?: string;
}

/**
 * A file announced mid-run, before the turn it belongs to has been written.
 *
 * It has no address yet, and that is not an oversight to fix by signing one
 * into the stream: a signed URL in every frame of every run would put a
 * credential on the wire for a link most readers never click, and the run is
 * seconds from persisting a message that carries one anyway. So the live row
 * says the file exists and what it weighs, and the download arrives with the
 * finished turn.
 */
export interface LiveFile {
  name: string;
  mimeType: string;
  byteSize?: number;
}

/** In-progress assistant turn rendered while a stream is active. */
export interface LiveTurn {
  text: string;
  toolCalls: LiveToolCall[];
  tools: LiveToolResult[];
  images: LiveImage[];
  files: LiveFile[];
  /** Bindings this run could not use, reported before the answer starts. */
  warnings: string[];
  /**
   * The chains currently producing chunks, each outermost first — cleared when
   * the top-level agent takes over again, so a badge never claims a subagent is
   * still running after it returned.
   *
   * A set rather than one chain: `dispatch_agents` has several children speaking
   * at the same time, and a single slot would flicker between them.
   */
  authorPaths: string[][];
}

export interface AgentProject {
  name: string;
  displayName: string;
  projectType: string;
}

export const EMPTY_TURN: LiveTurn = {
  text: "",
  toolCalls: [],
  tools: [],
  images: [],
  files: [],
  warnings: [],
  authorPaths: [],
};
