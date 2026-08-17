/**
 * How a messaging surface delivers a run's reply — the ports every chat-bot
 * adapter (Slack, Telegram, …) implements, and the only thing the shared turn
 * pipeline in `application/messaging` writes to.
 *
 * Two halves. {@link ReplySink} is the streamed answer and its progress: a
 * message that opens on the first output and grows, and a status the run keeps
 * updating. {@link ReplyChannel} is everything else a reply needs the surface
 * to do — post a standalone message, deliver a picture, and phrase the tail
 * (file links, warnings) the way that surface's markup reads them.
 *
 * Domain rather than application because it is vocabulary two slices share:
 * the pipeline calls it, each adapter implements it, and neither may import
 * the other.
 */

export interface ReplySink {
  /**
   * What the run is doing now. Throttled and never fatal.
   *
   * The caller says it once; the sink picks the rendering the surface has — a
   * status line, a task row on a stream, a typing indicator. `loadingMessages`
   * are the phrases a surface may rotate under the line while nothing more
   * specific is known; a surface without such a thing ignores them.
   */
  status(text: string, loadingMessages?: string[]): Promise<void>;
  /**
   * A unit of work began — a tool call, a hand-off — identified by something
   * stable for its lifetime.
   *
   * Where the surface renders a checklist this adds a row **per tool, not per
   * call** — reaching for the same one five times is one row saying five, which
   * is the sentence a checklist is for. Where it renders one status line, the
   * step takes the line over.
   *
   * `nested` marks work a subagent is doing. It still moves a status line, which
   * cannot accumulate and would otherwise sit still through a long hand-off; it
   * earns no checklist row, because the parent's own transfer row already stands
   * for the whole thing.
   */
  step(id: string, title: string, opts?: { nested?: boolean }): Promise<void>;
  /**
   * That unit of work finished. `title` replaces the one it opened with when the
   * ending says more than the beginning did — a tool result names what it acted
   * on, which the call alone does not.
   *
   * Only a real boundary may call this. Nothing else in a run has one: a status
   * line changing does not mean the last thing it said is *finished*, and a
   * checklist that ticked items off on that basis would claim the run completed
   * things it merely stopped mentioning.
   */
  stepDone(id: string, title?: string): Promise<void>;
  /**
   * Keep the current status from expiring while a run is in flight. Returns the
   * stopper; call it in a `finally` so a failed run does not leave a timer.
   */
  keepStatusAlive(): () => void;
  /** The answer *so far*. The sink works out what still needs sending. */
  push(fullText: string): Promise<void>;
  /** Deliver whatever is left, plus the tail, and clear the status. */
  finish(fullText: string, suffix: string): Promise<void>;
}

/** A picture a run produced or read, as the pipeline hands it to a surface. */
export interface ReplyImage {
  b64: string;
  mimeType: string;
  /** What it was drawn from, when the run drew it. */
  prompt?: string;
}

/**
 * The reply, whole: the streamed answer plus what sits beside it.
 *
 * `fileLink` and `warningLine` are here rather than in the pipeline because a
 * link is markup, and markup is the surface's — Slack reads `<url|name>` where
 * Telegram reads `<a href>`, and a name that is safe in one is syntax in the
 * other. The pipeline decides *what* the tail says; the channel decides how it
 * is spelled.
 */
export interface ReplyChannel extends ReplySink {
  /**
   * Post a standalone message, outside the streamed reply — a refusal, a
   * command's answer. Never opens the sink.
   */
  say(text: string): Promise<void>;
  /**
   * Deliver a picture. `index` is its position among the pictures this reply
   * carries, for a surface that names uploads.
   */
  sendImage(image: ReplyImage, index: number): Promise<void>;
  /** A link to a file the run produced, in this surface's markup. */
  fileLink(file: { url: string; name: string }): string;
  /** A line reporting something the run lost, in this surface's markup. */
  warningLine(text: string): string;
}
