"use client";

import { usePathname } from "next/navigation";
import { Alert, Stack } from "@mantine/core";
import { IconSettings } from "@tabler/icons-react";
import { PageHeader } from "@/app/_components/PageHeader";
import { PageTabs } from "@/app/_components/PageTabs";
import { useT } from "@/app/_i18n/provider";
import { useViewer } from "@/app/_lib/useViewer";
import { ModelSettingsNav } from "./ModelSettingsNav";
import { SETTINGS_TABS, SETTINGS_TAB_PATHS, settingsTabFor } from "./tabs";

export function SettingsShell({ children }: { children: React.ReactNode }) {
  const t = useT();
  const tab = settingsTabFor(usePathname());
  const viewer = useViewer();
  return <Stack gap="lg">
    <PageHeader title={t("nav.settings")} description={t("settings.overview")} Icon={IconSettings} />
    {viewer?.isAdmin ? <>
      <PageTabs value={SETTINGS_TAB_PATHS[tab]} label={t("nav.settings")}
        items={SETTINGS_TABS.map(value => ({ href: SETTINGS_TAB_PATHS[value], label: t(`settings.tab.${value}`) }))} />
      {tab === "models" && <ModelSettingsNav />}
      {children}
    </> : <Alert color="gray">{t("settings.adminOnly")}</Alert>}
  </Stack>;
}
