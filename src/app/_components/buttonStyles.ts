/**
 * The shape of a button, in one place.
 *
 * Forty-three buttons were spelled nineteen different ways, and the drift was
 * not only cosmetic: eleven carried no `disabled:` style at all, so a disabled
 * button looked exactly like a live one, and one danger button had lost its
 * dark-mode text colour. Both classes of bug disappear when the variant owns
 * the whole appearance.
 *
 * A button's *appearance* belongs here; its *layout* (`ml-auto`, `shrink-0`,
 * `w-full`) belongs to the caller — the same split `formStyles` uses. Applies
 * to `<Link>` as much as `<button>`, which is why this is a class rather than a
 * component: the two elements cannot share one.
 */

/** Colour and weight. Padding comes from the size. */
const VARIANT = {
  primary: "bg-brand font-medium text-white hover:bg-brand-strong",
  secondary:
    "border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800",
  danger:
    "border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40",
} as const;

const SIZE = {
  md: "px-3 py-2 text-sm",
  sm: "px-3 py-1.5 text-sm",
  xs: "px-2 py-1 text-xs",
} as const;

export type ButtonVariant = keyof typeof VARIANT;
export type ButtonSize = keyof typeof SIZE;

/**
 * `disabled:opacity-50` is unconditional. It was the single most-missed class,
 * and a button that cannot be pressed has to look that way whatever it is for.
 */
export function buttonClass(variant: ButtonVariant, size: ButtonSize = "md"): string {
  return `rounded-md ${SIZE[size]} ${VARIANT[variant]} disabled:opacity-50`;
}

/**
 * A button that reads as text: back links, and the inline actions that open a
 * dialog or expand a row. No padding and no border, so it sits in a sentence.
 */
export const textButtonClass = "text-sm text-neutral-500 hover:text-brand";

/**
 * Deliberately not the above: the chat sidebar and composer sit on a surface
 * whose bubbles are `rounded-2xl`, and a square-cornered button reads as
 * borrowed from another page. Kept here so the difference is a decision someone
 * can see rather than a copy that drifted.
 */
export const roundedPrimaryClass =
  "rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50";
