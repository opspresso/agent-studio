/**
 * Whether an Enter keydown is the reader asking, or an IME confirming.
 *
 * A composing input — Hangul, Kana, Pinyin — answers the Enter that commits a
 * candidate with a keydown of its own, and the browser marks it
 * `isComposing`. Reading that keystroke as "send" fires a turn the reader was
 * still typing, and fires it *before* React has the committed syllable in
 * state, so the message goes out missing its last character. The console's
 * primary readers type Korean, so this is the composer's default path rather
 * than an edge case.
 *
 * `keyCode === 229` is the same signal from browsers that report the
 * composition on the key rather than on the event; both are checked because a
 * miss here is silent — the text simply leaves without its ending.
 */
export function isSubmitEnter(event: React.KeyboardEvent): boolean {
  if (event.key !== "Enter") {
    return false;
  }
  const native = event.nativeEvent as KeyboardEvent | undefined;
  return !native?.isComposing && native?.keyCode !== 229;
}

/**
 * What ⌘/Ctrl+Enter means: run the panel's primary action from anywhere
 * inside it. Attached to a panel's root so every input in it answers the
 * same way, and the plain Enter keeps its native meaning (a newline in a
 * textarea, nothing in a text input). The caller guards its own
 * preconditions — this only decides which keystroke asks.
 */
export function onModEnter(action: () => void) {
  return (event: React.KeyboardEvent) => {
    // The same composition guard the plain Enter needs, for the same reason:
    // an IME can be mid-syllable when the shortcut arrives, and the panel
    // would run against a message React has not been given yet.
    if (isSubmitEnter(event) && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      action();
    }
  };
}
