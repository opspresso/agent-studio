/**
 * Keep a background timer from holding the process open.
 *
 * `unref` is a Node addition to the timer object, and `setTimeout`/`setInterval`
 * are typed here as the DOM's, which return a number — so every call site that
 * wants it has to spell the same cast. Six of them did, which is five too many
 * for a type-system workaround with no decision in it.
 */
export function unrefTimer(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}
