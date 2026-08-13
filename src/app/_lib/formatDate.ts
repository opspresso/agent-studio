/**
 * A stored row's timestamp (joined, last login), rendered for a table or card
 * in the console's active language. Distinct from `shared/date.ts`'s
 * `formatDateTime`, which the chat surfaces own — this one was the members
 * page's local helper until the profile page became its second consumer.
 *
 * The locale is passed rather than left to the runtime: see `shared/date.ts`
 * for why the default is both a hydration mismatch and the wrong answer for a
 * reader who has chosen a language.
 */
export function formatDate(value: string, locale?: Intl.LocalesArgument): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
