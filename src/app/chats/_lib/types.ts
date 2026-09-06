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
   * Head frame: how old the run already is when this frame goes out, measured
   * on the server between the instant the user row was stamped and now.
   *
   * An age rather than a timestamp, and that is what makes the reader's
   * stopwatch and the duration on the stored answer one measurement: the two
   * ends are read from the same clock, so nothing here depends on the browser's
   * agreeing with the server's. What it covers is the turn's own setup — the
   * attachment upload into object storage, a document being extracted, the
   * lease — which is real waiting the reader did and which the stored duration
   * counts too.
   */
  elapsedMs?: number;
  /**
   * Trailing frame: the *run* is over, as opposed to the connection. A closed
   * body says nothing about which of the two happened.
   */
  ended?: boolean;
  delta?: { content?: string; reasoningContent?: string; toolCalls?: unknown[] };
  toolResult?: unknown;
  image?: { b64: string; mimeType: string; prompt?: string };
  /**
   * A file the run produced. No `b64`: the bytes are stripped once stored, so
   * what arrives is the reference — and the address to fetch it by is signed
   * when the finished turn is read back, not here.
   *
   * `artifactId` is the exception, and not a contradiction of that: it is a row
   * id rather than a credential, and the route it addresses authorises every
   * request on its own. So a page can be opened the moment its bytes are in the
   * bucket, while a download still waits for the turn to be read back.
   */
  file?: { name: string; mimeType: string; byteSize?: number; key?: string; artifactId?: string };
  /**
   * Token accounting for one model call. Read for one number only — how much of
   * the turn went into thinking — which is why nothing else here is declared.
   */
  usage?: { reasoningTokens?: number };
  author?: string;
  /** Transfer chain that produced the chunk, outermost first. */
  authorPath?: string[];
  transferId?: string;
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
  author?: string | undefined;
  authorPath?: string[] | undefined;
  transferId?: string | undefined;
}

export interface LiveToolResult {
  /** The call this answers. Absent only for a result nothing declared. */
  id?: string | undefined;
  name?: string | undefined;
  content: string;
  author?: string | undefined;
  authorPath?: string[] | undefined;
  transferId?: string | undefined;
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
  /**
   * Present from the chunk that stored it, which is why a page can be opened
   * while the turn is still running: the bytes are in the bucket by the time
   * the reference reaches here, and only the download address waits for the
   * finished turn to be read back.
   */
  artifactId?: string;
}

/** In-progress assistant turn rendered while a stream is active. */
export interface LiveTurn {
  text: string;
  /**
   * The run's thinking so far — empty unless the version opted into recording
   * it, since the engine emits nothing otherwise.
   */
  reasoning: string;
  /** Reasoning tokens this run has spent, when the provider reported any. */
  reasoningTokens: number;
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
  description?: string;
  projectType: string;
}

export const EMPTY_TURN: LiveTurn = {
  text: "",
  reasoning: "",
  reasoningTokens: 0,
  toolCalls: [],
  tools: [],
  images: [],
  files: [],
  warnings: [],
  authorPaths: [],
};
