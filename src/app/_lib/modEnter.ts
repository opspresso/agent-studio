/**
 * What ⌘/Ctrl+Enter means: run the panel's primary action from anywhere
 * inside it. Attached to a panel's root so every input in it answers the
 * same way, and the plain Enter keeps its native meaning (a newline in a
 * textarea, nothing in a text input). The caller guards its own
 * preconditions — this only decides which keystroke asks.
 */
export function onModEnter(action: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      action();
    }
  };
}
