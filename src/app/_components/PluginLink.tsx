"use client";

import { NavigationLink } from "@/app/_components/NavigationLink";

import { IconPackage } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";

/** A capability's source is navigation, with the same affordance on Skill and Tool details. */
export function PluginLink({ name }: { name: string }) {
  const t = useT();
  return <NavigationLink href={`/plugins/${encodeURIComponent(name)}`} label={t("registry.pluginLink", { name })}>
    <IconPackage size={14} aria-hidden="true" />{name}
  </NavigationLink>;
}
