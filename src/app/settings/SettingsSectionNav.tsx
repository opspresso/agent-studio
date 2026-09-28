"use client";

import { usePathname } from "next/navigation";
import { useT } from "@/app/_i18n/provider";
import { PageTabs } from "@/app/_components/PageTabs";
import { SETTINGS_SECTION_TABS } from "./tabs";

export function SettingsSectionNav({ section }: { section: "models" | "plugins" }) {
  const t = useT();
  const path = usePathname();
  return <PageTabs value={path} label={t(`settings.tab.${section}`)} variant="pills"
    items={SETTINGS_SECTION_TABS[section].map(([href, label]) => ({ href, label: t(label) }))} />;
}
