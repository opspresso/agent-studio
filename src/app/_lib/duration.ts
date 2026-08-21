/**
 * How long something took, as a reader reads it.
 *
 * Two callers, one wording: the stopwatch on a run in flight and the badge on
 * the answer it produced. They differ in where the number comes from, not in
 * how it reads, so a run that shows `42s` and then settles as `42s` says the
 * same thing twice rather than switching units at the finish line.
 *
 * The catalogue owns the units — `s`/`m` in English, `초`/`분` in Korean — so
 * this takes a translator rather than spelling either.
 */
import type { Translate } from "@/app/_i18n/translate";

const SECONDS_PER_MINUTE = 60;

/** Whole seconds → `42s` / `1m 23s`. */
export function formatSeconds(totalSeconds: number, t: Translate): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  if (whole < SECONDS_PER_MINUTE) {
    return t("chat.durationSeconds", { seconds: whole });
  }
  return t("chat.durationMinutes", {
    minutes: Math.floor(whole / SECONDS_PER_MINUTE),
    seconds: whole % SECONDS_PER_MINUTE,
  });
}

/**
 * A finished duration in milliseconds → the same wording.
 *
 * Rounded rather than truncated, because this one is a measurement being
 * reported: a run of 1,900ms reads as `2s`. The stopwatch truncates instead —
 * it counts time that has passed, and a clock that shows `1s` before a second
 * is up is wrong in the direction a reader notices.
 */
export function formatDuration(ms: number, t: Translate): string {
  return formatSeconds(Math.round(Math.max(0, ms) / 1000), t);
}
