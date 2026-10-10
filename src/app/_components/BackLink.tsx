"use client";

import { NavigationLink } from "@/app/_components/NavigationLink";

import { useT } from "@/app/_i18n/provider";

/**
 * The boxed return link a detail page opens with.
 *
 * The whole sentence is one message rather than a prefix plus the label,
 * because Korean puts the destination before the verb — a fixed prefix would
 * have pinned the word order to English.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  const t = useT();
  return (
    <NavigationLink back href={href}>
      {t("common.backTo", { label })}
    </NavigationLink>
  );
}
