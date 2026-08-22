"use client";

import { Badge, Code, Stack, Text } from "@mantine/core";
import { CollapsibleCode } from "@/app/_components/CollapsibleCode";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { stateColor } from "@/app/_components/badgeColors";
import { useT } from "@/app/_i18n/provider";
import { aguiClientExample } from "../api-reference/endpoints";

/**
 * How an application embeds this project through AG-UI: the endpoint, what
 * it authenticates with, and the shortest client that talks to it. Nothing
 * is fetched — the address is a function of the name, and whether it answers
 * is a function of the published pointer the page already holds.
 */
export function AguiSection({ projectName, published }: { projectName: string; published: boolean }) {
  const t = useT();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = `${origin}/api/agui/${projectName}`;

  return (
    <CollapsibleSection
      title={t("pset.agui")}
      badge={
        <Badge color={stateColor(published)} radius="xl">
          {published ? "exposed" : "not published"}
        </Badge>
      }
    >
      <Stack gap="sm">
        <Text fz="xs" c="dimmed" lh={1.6}>
          {t("pint.aguiLede")} <Code>Authorization: Bearer</Code>
        </Text>
        {!published && (
          <Text fz="sm" c="dimmed">
            {t("pint.aguiPublish")}
          </Text>
        )}
        <CopyableUrl url={url} />
        <CollapsibleCode
          title="@ag-ui/client"
          language="javascript"
          code={aguiClientExample(url)}
          copyLabel={t("pint.aguiCopy")}
        />
      </Stack>
    </CollapsibleSection>
  );
}
