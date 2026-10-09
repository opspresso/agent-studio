"use client";

import { Alert } from "@mantine/core";
import { useViewer } from "@/app/_lib/useViewer";
import { useT } from "@/app/_i18n/provider";
import { LoadingText } from "@/app/_components/PageState";
import { UsageExplorer } from "@/app/_components/UsageExplorer";

export function AdminUsage({ initialUser }: { initialUser?: string }) {
  const viewer = useViewer();
  const t = useT();
  if (!viewer) return <LoadingText />;
  if (!viewer.isAdmin) return <Alert color="gray">{t("usage.adminOnly")}</Alert>;
  return <UsageExplorer admin initialUser={initialUser} />;
}
