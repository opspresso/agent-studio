/**
 * Live and finished durations share truncation to whole seconds and translated
 * units (`s`/`m` or `초`/`분`), keeping the display stable when a run finishes.
 */
import type { Translate } from "@/app/_i18n/translate";

const SECONDS_PER_MINUTE = 60;

/** Whole seconds → `42s` / `1m 23s`. */
export function formatSeconds(totalSeconds: number, t: Translate): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  if (whole < SECONDS_PER_MINUTE) {
    return t("common.durationSeconds", { seconds: whole });
  }
  return t("common.durationMinutes", {
    minutes: Math.floor(whole / SECONDS_PER_MINUTE),
    seconds: whole % SECONDS_PER_MINUTE,
  });
}

/** Finished milliseconds, using the same whole-second display as the stopwatch. */
export function formatDuration(ms: number, t: Translate): string {
  return formatSeconds(Math.max(0, ms) / 1000, t);
}
