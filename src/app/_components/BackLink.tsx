"use client";

import Link from "next/link";
import { Anchor } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";

/**
 * The dimmed "← Back to …" line a detail page opens with.
 *
 * The whole sentence is one message rather than a prefix plus the label,
 * because Korean puts the destination before the verb — a fixed prefix would
 * have pinned the word order to English.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  const t = useT();
  return (
    <Anchor component={Link} href={href} fz="sm" c="dimmed">
      {t("common.backTo", { label })}
    </Anchor>
  );
}
