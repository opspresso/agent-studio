"use client";

import Link from "next/link";
import { Anchor } from "@mantine/core";
import { IconPackage } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";

/** A capability's source is navigation, with the same affordance on Skill and Tool details. */
export function PluginLink({ name }: { name: string }) {
  const t = useT();
  return <Anchor component={Link} href={`/plugins/${encodeURIComponent(name)}`} size="sm" fw={500}
    aria-label={t("registry.pluginLink", { name })} display="inline-flex" mih={24} style={{ alignItems: "center", gap: 4 }}>
    <IconPackage size={14} aria-hidden="true" />{name}
  </Anchor>;
}
