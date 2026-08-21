/**
 * How long something took, as a reader reads it.
 *
 * Two callers, one wording and one rounding: the stopwatch on a run in flight
 * and the badge on the answer it produced. They differ in where the number
 * comes from, not in how it reads, so a run that shows `42s` and then settles
 * as `42s` says the same thing twice rather than switching units — or gaining
 * a second — at the finish line.
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
    return t("common.durationSeconds", { seconds: whole });
  }
  return t("common.durationMinutes", {
    minutes: Math.floor(whole / SECONDS_PER_MINUTE),
    seconds: whole % SECONDS_PER_MINUTE,
  });
}

/**
 * A finished duration in milliseconds → the same wording.
 *
 * Truncated, like the stopwatch, and that is the whole point of the pair: a
 * reply whose last live frame read `42s` settles as `42s`. Rounding here
 * instead — defensible on its own, since this one is a measurement being
 * reported rather than a clock — made the number tick up one last time after
 * the run had stopped, for every reply whose fractional second was past the
 * half. The reader watches those two states in the same spot, seconds apart.
 */
export function formatDuration(ms: number, t: Translate): string {
  return formatSeconds(Math.max(0, ms) / 1000, t);
}
