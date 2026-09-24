"use client";

import { usePathname } from "next/navigation";
import { useT } from "@/app/_i18n/provider";
import { PageTabs } from "@/app/_components/PageTabs";

export function ModelSettingsNav() {
  const t = useT();
  const path = usePathname();
  const links = [
    ["/settings/providers", "modelAdmin.providers"],
    ["/settings/models", "modelAdmin.selection"],
    ["/settings/models/registered", "settings.models.registered"],
    ["/settings/model-usage", "modelAdmin.usage"],
  ] as const;
  return <PageTabs value={path} label={t("settings.tab.models")} variant="pills" items={links.map(([href, label]) => ({ href, label: t(label) }))} />;
}
