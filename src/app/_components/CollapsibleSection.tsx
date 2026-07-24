"use client";

/**
 * Collapsible card built on native <details>. Closed by default; the title and
 * optional badge stay visible in the summary so state is readable while collapsed.
 */
export function CollapsibleSection({
  title,
  badge,
  titleClassName = "text-sm font-semibold uppercase tracking-wide text-neutral-500",
  className = "border-neutral-200 dark:border-neutral-800",
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  titleClassName?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <details className={`group rounded-lg border ${className}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
            className="h-4 w-4 text-neutral-400 transition-transform group-open:rotate-90"
          >
            <path d="M7 5l6 5-6 5V5z" />
          </svg>
          <span className={titleClassName}>{title}</span>
        </span>
        {badge}
      </summary>
      <div className="space-y-4 px-4 pb-4">{children}</div>
    </details>
  );
}
