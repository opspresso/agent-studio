import { notifications } from "@mantine/notifications";

/**
 * A failed action's message — shown in place, and raised as a notification.
 *
 * The inline alert beside the form is the right place for the explanation: it
 * is anchored to the thing that failed and it stays. What it cannot do is be
 * *seen*. These pages are long — the schedules list, the model catalogue, a
 * project's settings — and the press that failed is often nowhere near the top
 * of the viewport by the time the answer comes back, so a save that did not
 * happen looked exactly like a save that did.
 *
 * Only actions a person asked for go through here. A page that failed to
 * *load* has nothing else on it, so its alert is already the only thing to
 * look at; a toast there would be noise the moment the network flickers.
 *
 * The message itself stays as thrown — English, like every error in this
 * console, because it is usually an `AppError`'s string and `application` and
 * `domain` may not import a framework to translate it. The `fallback` is for
 * the rare throw that is not an `Error` at all.
 */
export function reportError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  notifications.show({
    color: "red",
    message,
    // Longer than the default: an error a reader scrolled back to find is one
    // they need to read, and an eight-second toast is still a toast.
    autoClose: 8_000,
  });
  return message;
}
