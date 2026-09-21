"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button, Group } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";

export function ModelSettingsNav() {
  const t = useT();
  const path = usePathname();
  const links = [
    ["/settings/providers", "modelAdmin.providers"],
    ["/settings/models", "modelAdmin.selection"],
    ["/settings/model-usage", "modelAdmin.usage"],
    ["/models", "nav.models"],
  ] as const;
  return <Group gap="xs">{links.map(([href, label]) => <Button component={Link} href={href} key={href}
    variant={path === href ? "light" : "subtle"} aria-current={path === href ? "page" : undefined}>{t(label)}</Button>)}</Group>;
}
