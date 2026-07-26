/**
 * A short label beside a name — a protocol, a credential kind, a count.
 *
 * The markup was copied into four files and had already drifted: one copy lost
 * its dark-mode text colour, so the same badge read at a different contrast
 * depending on which page you were on. It is one line of classes, which is
 * exactly why nobody noticed.
 *
 * `className` takes layout only (`shrink-0` and friends) — the appearance is
 * this component's, or there is no point having it.
 */
export function Badge({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 ${className}`}
    >
      {children}
    </span>
  );
}
