"use client";

import { useState } from "react";
import { Alert, Badge, Button, Group, Radio, Stack, Text } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { updateAgent, type AgentVisibility, type SanitizedAgent } from "../../lib/api";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";

export function VisibilitySection({
  agentName,
  agent,
}: {
  agentName: string;
  agent: Pick<SanitizedAgent, "visibility">;
}) {
  const t = useT();
  const [visibility, setVisibility] = useState<AgentVisibility>(agent.visibility ?? "public");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const agent = await updateAgent(agentName, { visibility });
      setVisibility(agent.visibility ?? "public");
      setSaved(true);
    } catch (e) {
      setError(reportError(e, "Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CollapsibleSection
      title={t("pset.visibility")}
      badge={
        visibility === "private" ? (
          <Badge variant="light" color="gray">
            {t("agents.privateBadge")}
          </Badge>
        ) : (
          <Badge variant="light" color="teal">
            {t("pset.visibilityPublic")}
          </Badge>
        )
      }
    >
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Radio.Group
          value={visibility}
          onChange={(value) => setVisibility(value as AgentVisibility)}
        >
          <Stack gap="xs">
            <Radio
              value="public"
              label={t("pset.visibilityPublic")}
              description={t("pset.visibilityPublicHint")}
            />
            <Radio
              value="private"
              label={t("pset.visibilityPrivate")}
              description={t("pset.visibilityPrivateHint")}
            />
          </Stack>
        </Radio.Group>
        <Group gap="sm">
          <Button onClick={save} loading={saving}>
            {t("pset.visibilitySave")}
          </Button>
          {saved && (
            <Text fz="sm" c="teal">
              Saved
            </Text>
          )}
        </Group>
      </Stack>
    </CollapsibleSection>
  );
}
