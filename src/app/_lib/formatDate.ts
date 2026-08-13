/**
 * A stored row's timestamp (joined, last login), rendered for a table or card
 * in the viewer's own locale. Distinct from `shared/date.ts`'s
 * `formatDateTime`, which the chat surfaces own — this one was the members
 * page's local helper until the profile page became its second consumer.
 */
export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
