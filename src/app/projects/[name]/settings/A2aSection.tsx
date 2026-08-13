"use client";

import { useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CollapsibleCode } from "@/app/_components/CollapsibleCode";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { getProjectA2a } from "../../lib/api";
import type { ProjectA2aView } from "../../lib/api";
import { Badge, Code, Stack, Text } from "@mantine/core";
import { stateColor } from "@/app/_components/badgeColors";
import { useT } from "@/app/_i18n/provider";

export function A2aSection({ projectName }: { projectName: string }) {
  const t = useT();
  const [view, setView] = useState<ProjectA2aView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProjectA2a(projectName)
      .then((v) => !cancelled && setView(v))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Load failed"));
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  if (!view) {
    return error ? (
      <Text fz="sm" c="red">
        {error}
      </Text>
    ) : null;
  }

  const ready = view.enabled && view.published;

  return (
    <CollapsibleSection
      title={t("pset.a2a")}
      badge={
        <Badge color={stateColor(ready)} radius="xl">
          {ready ? "exposed" : view.enabled ? "not published" : "disabled"}
        </Badge>
      }
    >
      <Stack gap="sm">
        <Text fz="xs" c="dimmed" lh={1.6}>
          The published version is exposed as an A2A agent. Share the Agent Card URL with external
          systems; callers authenticate with the <Code>X-A2A-Key</Code> header.
        </Text>

        {!view.enabled && (
          <Text fz="sm" c="dimmed">
            Set <Code>A2A_API_KEY</Code> on the server to enable A2A endpoints.
          </Text>
        )}
        {view.enabled && !view.published && (
          <Text fz="sm" c="dimmed">
            Publish a version to expose this project over A2A.
          </Text>
        )}

        {view.cardUrl && <CopyableUrl url={view.cardUrl} />}

        {view.card && (
          <CollapsibleCode
            title={t("pset.agentCard")}
            language="json"
            code={JSON.stringify(view.card, null, 2)}
            copyLabel="Copy card"
          />
        )}

        {error && (
          <Text fz="sm" c="red">
            {error}
          </Text>
        )}
      </Stack>
    </CollapsibleSection>
  );
}
