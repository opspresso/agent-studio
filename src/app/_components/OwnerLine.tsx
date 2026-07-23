/** Shared owner line: owner email plus a brand-colored "you" badge for the viewer's own items. */
export function OwnerLine({
  ownerEmail,
  isMine,
  prefix,
  className,
}: {
  ownerEmail: string;
  isMine: boolean;
  prefix?: string;
  className?: string;
}) {
  return (
    <span className={`flex items-center gap-1.5 text-xs text-neutral-400 ${className ?? ""}`}>
      <span className="truncate">
        {prefix}
        {ownerEmail}
      </span>
      {isMine && (
        <span className="rounded bg-brand/10 px-1 py-0.5 font-medium text-brand">you</span>
      )}
    </span>
  );
}
