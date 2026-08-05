/**
 * Who owns a chat's live stream.
 *
 * Not the component that started it. A turn used to live in `ChatThread`'s
 * state, so opening another chat — or any client-side navigation at all —
 * unmounted the thing accumulating the answer and the reply vanished from the
 * screen while the run carried on server-side. The stream is owned here instead,
 * above the router, and a view subscribes to it.
 *
 * Deliberately free of React, `window` and `next/*`: this is the part with the
 * logic worth testing, and the test environment is plain Node with no DOM. The
 * eleven lines of `useSyncExternalStore` wiring live in `runHooks.ts`.
 *
 * Three rules the rest of the file depends on:
 *
 * - **An entry is replaced, never mutated.** It is a `useSyncExternalStore`
 *   snapshot; a mutation in place is a render React will not schedule.
 * - **`runningChatIds()` returns the same array until membership changes.** A
 *   fresh array every call is an infinite render loop, not a re-render.
 * - **Nothing here aborts a stream on unmount.** The server treats a dropped
 *   connection as "the reader left", and only an explicit stop ends a run — so
 *   an `AbortController` added for tidiness would silently restore the bug this
 *   exists to fix.
 */

import { isTopLevelChunk } from "@/domain/llm/types";
import { unrefTimer } from "@/shared/unrefTimer";
import { toRequestImages, type Attachment } from "@/app/_lib/imageAttachments";
import type { DocumentAttachment } from "@/app/_lib/documentAttachments";
import { readSse } from "./sseClient";
import { reduceChunk } from "./stream";
import { EMPTY_TURN, type Chat, type LiveTurn, type StreamChunk } from "./types";

/** The turn as the user sent it, drawn until the persisted copy replaces it. */
export interface PendingUser {
  content: string;
  attachments: Attachment[];
  documents: DocumentAttachment[];
}

export interface RunEntry {
  /** Monotonic, so a view can say "I have already shown this turn". */
  readonly id: number;
  /** Unknown until the head frame arrives, on a chat being created. */
  readonly chatId?: string;
  readonly runId?: string;
  /** Where the user's turn landed; absent until the head frame names it. */
  readonly userSeq?: number;
  readonly status: "streaming" | "finished" | "failed";
  readonly live: LiveTurn;
  /** Absent when this tab attached to a run it did not start. */
  readonly pendingUser?: PendingUser;
  readonly error?: string;
  readonly chat?: Chat;
}

export interface RunStore {
  subscribe(listener: () => void): () => void;
  /** The entry for a chat id, or for the placeholder key a new chat started under. */
  get(key: string): RunEntry | undefined;
  /** Chat ids with a run in flight. Identity-stable while membership holds. */
  runningChatIds(): readonly string[];
  /** Send a turn to an existing chat. Returns the key to read it back by. */
  startTurn(chatId: string, pending: PendingUser): string;
  /** Start a chat. Returns a placeholder key, aliased to the chat id once it exists. */
  startNewChat(projectName: string, pending: PendingUser): string;
  /** Pick up a run this tab did not start — a reload, or a second window. */
  attach(chatId: string, runId: string): void;
  /** A view has shown this turn and taken what it needs; free the bytes. */
  release(key: string, id: number): void;
  /** Stop reading, and forget. Does not stop the run — see `cancelRun`. */
  abort(key: string): void;
  /** Ask the server to stop the run behind this entry. */
  cancelRun(key: string): void;
}

/**
 * How long a finished turn nobody claimed is kept. Long enough for a view to
 * mount and take its images, short enough that a tab left open on another page
 * is not holding megabytes of base64.
 */
const ORPHAN_TTL_MS = 60_000;

/**
 * A ceiling on finished entries, because a backgrounded tab's timers are
 * throttled and the TTL alone is not a bound.
 */
const MAX_FINISHED = 2;

/** Reconnect attempts before a lost stream is reported as lost. */
const MAX_RECONNECTS = 2;

const NO_RUNS: readonly string[] = Object.freeze([]);

export function createRunStore(): RunStore {
  const entries = new Map<string, RunEntry>();
  /** Placeholder key → chat id, once a new chat learns its own. */
  const alias = new Map<string, string>();
  const controllers = new Map<string, AbortController>();
  const evictions = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  let running: readonly string[] = NO_RUNS;
  let nextId = 1;
  let nextPlaceholder = 1;

  function canonical(key: string): string {
    return alias.get(key) ?? key;
  }

  function refreshRunning(): void {
    const current: string[] = [];
    for (const entry of entries.values()) {
      if (entry.status === "streaming" && entry.chatId) {
        current.push(entry.chatId);
      }
    }
    // Replaced only when the membership actually changed: the array is a
    // snapshot, and a new one every call is a render loop.
    const unchanged =
      current.length === running.length && current.every((id, index) => running[index] === id);
    if (!unchanged) {
      running = Object.freeze(current);
    }
  }

  function emit(): void {
    refreshRunning();
    for (const listener of listeners) {
      listener();
    }
  }

  function update(key: string, updater: (prev: RunEntry) => RunEntry): void {
    const canon = canonical(key);
    const prev = entries.get(canon);
    if (!prev) {
      return;
    }
    entries.set(canon, updater(prev));
    emit();
  }

  function evict(key: string): void {
    const canon = canonical(key);
    const timer = evictions.get(canon);
    if (timer) {
      clearTimeout(timer);
      evictions.delete(canon);
    }
    entries.delete(canon);
    for (const [placeholder, target] of alias) {
      if (target === canon) {
        alias.delete(placeholder);
      }
    }
    emit();
  }

  function capFinished(): void {
    const finished = [...entries.entries()]
      .filter(([, entry]) => entry.status !== "streaming")
      .sort(([, a], [, b]) => a.id - b.id);
    for (const [key] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
      evict(key);
    }
  }

  function finish(key: string, status: "finished" | "failed", error?: string): void {
    update(key, (prev) => ({ ...prev, status, ...(error ? { error } : {}) }));
    const canon = canonical(key);
    if (!entries.has(canon)) {
      return;
    }
    const timer = setTimeout(() => evict(canon), ORPHAN_TTL_MS);
    unrefTimer(timer);
    evictions.set(canon, timer);
    capFinished();
  }

  /**
   * Take what the head frame says, and re-key a new chat from its placeholder to
   * the id it just learned.
   */
  function adopt(key: string, head: StreamChunk): void {
    const canon = canonical(key);
    const chatId = head.chat?.chatId;
    if (chatId && canon !== chatId) {
      const entry = entries.get(canon);
      entries.delete(canon);
      if (entry) {
        entries.set(chatId, entry);
      }
      const controller = controllers.get(canon);
      if (controller) {
        controllers.delete(canon);
        controllers.set(chatId, controller);
      }
      alias.set(canon, chatId);
    }
    update(key, (prev) => ({
      ...prev,
      ...(head.chat ? { chat: head.chat, chatId: head.chat.chatId } : {}),
      ...(head.runId ? { runId: head.runId } : {}),
      ...(head.userSeq !== undefined ? { userSeq: head.userSeq } : {}),
    }));
  }

  async function activeRunOf(chatId: string, signal: AbortSignal): Promise<string | undefined> {
    const res = await fetch(`/api/chats/${chatId}`, { signal });
    if (!res.ok) {
      return undefined;
    }
    const data = (await res.json()) as { activeRun?: { runId: string } };
    return data.activeRun?.runId;
  }

  /**
   * Read a run to its end, reconnecting to the replay endpoint if the body
   * closes while the run is still going.
   *
   * A replay always starts from the beginning, so the first chunk after a
   * reconnect is folded into an empty turn rather than onto what is on screen.
   * The rebuilt prefix is identical — `reduceChunk` is a pure fold — so nothing
   * moves.
   */
  async function pump(
    key: string,
    open: (signal: AbortSignal) => Promise<Response>,
  ): Promise<void> {
    const controller = new AbortController();
    controllers.set(canonical(key), controller);
    let request = () => open(controller.signal);
    let attempt = 0;
    try {
      for (;;) {
        let rebuilding = attempt > 0;
        let ended = false;
        // A stream can stop two ways and only one of them resolves: a body that
        // closes cleanly ends the `for await`, while a connection cut — the ALB
        // dropping an idle stream is the one this deployment actually sees —
        // rejects out of it. Both mean the same thing here, so the read is
        // caught and both fall through to the reconnect decision below. Letting
        // the reject reach the outer catch reported a run still producing as a
        // network failure, and never tried to pick it back up.
        let lost: string | undefined;
        try {
          const res = await request();
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            finish(key, "failed", body.error ?? `request failed (${res.status})`);
            return;
          }
          for await (const chunk of readSse(res)) {
            if (controller.signal.aborted) {
              return;
            }
            if (chunk.ended) {
              ended = true;
              continue;
            }
            if (chunk.chat || chunk.runId) {
              adopt(key, chunk);
              continue;
            }
            if (chunk.error) {
              // An authored error is a subagent failure the parent usually
              // answers past; only a top-level one is the run's.
              if (isTopLevelChunk(chunk)) {
                update(key, (prev) => ({ ...prev, error: chunk.error }));
              }
              continue;
            }
            const fold = rebuilding;
            rebuilding = false;
            update(key, (prev) => ({
              ...prev,
              live: reduceChunk(fold ? EMPTY_TURN : prev.live, chunk),
            }));
          }
        } catch (error) {
          lost = error instanceof Error ? error.message : "stream error";
        }
        if (controller.signal.aborted) {
          return;
        }
        if (ended) {
          finish(key, "finished");
          return;
        }

        // The stream stopped without the run saying it was over.
        const entry = entries.get(canonical(key));
        const chatId = entry?.chatId;
        const runId = entry?.runId;
        if (!chatId || !runId || attempt >= MAX_RECONNECTS) {
          finish(key, "failed", lost ?? "The connection to this reply was lost.");
          return;
        }
        let active: string | undefined;
        try {
          active = await activeRunOf(chatId, controller.signal);
        } catch {
          // The probe is on the same broken network as the stream was. Treat it
          // as "cannot say", and let the attempt count end this rather than a
          // one-off failure the next poll might have answered.
          active = runId;
        }
        if (controller.signal.aborted) {
          return;
        }
        if (active !== runId) {
          // It finished in the gap; the answer is in the conversation.
          finish(key, "finished");
          return;
        }
        attempt += 1;
        request = () =>
          fetch(`/api/chats/${chatId}/runs/${runId}/stream`, { signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        finish(key, "failed", error instanceof Error ? error.message : "stream error");
      }
    } finally {
      controllers.delete(canonical(key));
    }
  }

  function create(key: string, partial: Partial<RunEntry>): void {
    // Whatever was here is gone, including its pending eviction — a timer armed
    // for the *previous* turn would otherwise fire sixty seconds later and take
    // this one, still streaming, with it.
    if (entries.has(key)) {
      evict(key);
    }
    entries.set(key, {
      id: nextId++,
      status: "streaming",
      live: EMPTY_TURN,
      ...partial,
    });
    emit();
  }

  const store: RunStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get(key) {
      return entries.get(canonical(key));
    },

    runningChatIds() {
      return running;
    },

    startTurn(chatId, pending) {
      if (entries.get(chatId)?.status === "streaming") {
        // The client-side mirror of the server's one-run-per-chat lease.
        return chatId;
      }
      create(chatId, { chatId, pendingUser: pending });
      void pump(chatId, (signal) =>
        fetch(`/api/chats/${chatId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: pending.content,
            images: toRequestImages(pending.attachments),
            documents: pending.documents,
          }),
          signal,
        }),
      );
      return chatId;
    },

    startNewChat(projectName, pending) {
      const key = `new:${nextPlaceholder++}`;
      create(key, { pendingUser: pending });
      void pump(key, (signal) =>
        fetch("/api/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectName,
            firstMessage: pending.content,
            images: toRequestImages(pending.attachments),
            documents: pending.documents,
          }),
          signal,
        }),
      );
      return key;
    },

    attach(chatId, runId) {
      if (entries.get(chatId)?.status === "streaming") {
        return;
      }
      // No `pendingUser`: the turn that started this run is already a stored
      // message, and drawing it again would show it twice.
      create(chatId, { chatId, runId });
      void pump(chatId, (signal) =>
        fetch(`/api/chats/${chatId}/runs/${runId}/stream`, { signal }),
      );
    },

    release(key, id) {
      const canon = canonical(key);
      const entry = entries.get(canon);
      // Guarded on the id because effects run twice in development, and the
      // second pass must not evict a turn that started since.
      if (entry && entry.id === id && entry.status !== "streaming") {
        evict(canon);
      }
    },

    abort(key) {
      const canon = canonical(key);
      controllers.get(canon)?.abort();
      controllers.delete(canon);
      evict(canon);
    },

    cancelRun(key) {
      const entry = entries.get(canonical(key));
      if (!entry?.chatId || !entry.runId) {
        return;
      }
      // Fire and forget: the run answers the stop by ending its own stream,
      // which this store is already watching. A failed request leaves the run
      // going, which the reader can see for themselves.
      void fetch(`/api/chats/${entry.chatId}/runs/${entry.runId}`, { method: "DELETE" }).catch(
        () => undefined,
      );
    },
  };

  return store;
}

/** The store the app uses. A factory as well, so tests are not order-dependent. */
export const runStore: RunStore = createRunStore();
