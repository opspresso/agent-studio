"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Alert, Stack, Tabs } from "@mantine/core";
import { IconSettings } from "@tabler/icons-react";
import { PageHeader } from "@/app/_components/PageHeader";
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
      <Tabs value={tab}>
        <Tabs.List aria-label={t("nav.settings")}>{SETTINGS_TABS.map(value => <Tabs.Tab key={value} value={value}
          renderRoot={props => <Link {...props} href={SETTINGS_TAB_PATHS[value]} />}>{t(`settings.tab.${value}`)}</Tabs.Tab>)}</Tabs.List>
      </Tabs>
      {tab === "models" && <ModelSettingsNav />}
      {children}
    </> : <Alert color="gray">{t("settings.adminOnly")}</Alert>}
  </Stack>;
}
