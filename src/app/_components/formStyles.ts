/**
 * The shape of a text control, in one place.
 *
 * There were five constants named `inputClass` with five different values, plus
 * thirty-six inline copies across ten spellings — and three of those had already
 * lost the focus ring, so tabbing through some forms showed no focus at all.
 * A control's *appearance* belongs here; its *layout* (width, margin) belongs to
 * the caller, which is why the base carries neither.
 */
export const controlClass =
  "rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700";

/** The base, for values read character by character. See {@link monoFieldClass}. */
export const monoControlClass = `${controlClass} font-mono`;

/** A control filling the width under a label caption — most of them. */
export const fieldClass = `mt-1 w-full ${controlClass}`;

/**
 * For values read character by character rather than as words: tokens, URLs,
 * header values, model ids.
 */
export const monoFieldClass = `${fieldClass} font-mono`;

/**
 * Deliberately not the above: the date range sits inline in a toolbar, where the
 * standard control's padding would set the row height. Kept here so the
 * difference is a decision someone can see rather than a copy that drifted.
 */
export const compactControlClass =
  "rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900";
