import Link from "next/link";
import { Anchor } from "@mantine/core";

/** The dimmed "← Back to …" line a detail page opens with. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Anchor component={Link} href={href} fz="sm" c="dimmed">
      ← Back to {label}
    </Anchor>
  );
}
