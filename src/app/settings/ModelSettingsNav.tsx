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
    ["/settings/model-usage", "modelAdmin.usage"],
    ["/settings/models/registered", "settings.models.registered"],
  ] as const;
  return <PageTabs value={path} label={t("settings.tab.models")} variant="pills" items={links.map(([href, label]) => ({ href, label: t(label) }))} />;
}
