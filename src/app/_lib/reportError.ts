import { notifications } from "@mantine/notifications";

/**
 * Notify a failed user action and return its message for the persistent inline
 * alert. The toast stays visible when a long form's alert is off-screen.
 * Initial page-load failures use their own alert instead.
 *
 * Preserve Error messages; use the fallback only for other thrown values.
 */
export function reportError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  notifications.show({
    color: "red",
    message,
    // Allow time to read the failure while keeping the inline alert persistent.
    autoClose: 8_000,
  });
  return message;
}
