"use client";

import { useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { useConfirm } from "@/app/_components/useConfirm";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import {
  disconnectProjectTeams,
  getProjectTeams,
  testProjectTeams,
  updateProjectTeams,
} from "../../lib/api";
import type { ProjectTeamsResponse, ProjectType } from "../../lib/api";
import { Alert, Badge, Button, Checkbox, Group, Stack, Text, TextInput } from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { stateColor } from "@/app/_components/badgeColors";
import { useT } from "@/app/_i18n/provider";

export function TeamsSection({
  projectName,
  projectType,
}: {
  projectName: string;
  projectType: ProjectType;
}) {
  const t = useT();
  const [view, setView] = useState<ProjectTeamsResponse | null>(null);
  const [appId, setAppId] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmModal } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    getProjectTeams(projectName)
      .then((v) => {
        if (!cancelled) {
          setView(v);
          setAppId(v.appId);
          setAppPassword(v.appPassword);
          setTenantId(v.tenantId);
          setEnabled(v.enabled);
        }
      })
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

  async function save() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const next = await updateProjectTeams(projectName, { appId, appPassword, tenantId, enabled });
      setView(next);
      setAppId(next.appId);
      setAppPassword(next.appPassword);
      setTenantId(next.tenantId);
      setEnabled(next.enabled);
      setStatus("Saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const result = await testProjectTeams(projectName);
      setStatus(`Connected: token issued for ${result.appId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection test failed");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (
      !(await confirm({
        title: "Remove Teams credentials",
        message: "Remove the Teams bot registration for this project? The Azure Bot itself is untouched.",
        confirmLabel: "Remove",
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await disconnectProjectTeams(projectName);
      const next = await getProjectTeams(projectName);
      setView(next);
      setAppId("");
      setAppPassword("");
      setTenantId("");
      setEnabled(false);
      setStatus("Disconnected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  // A Teams message runs the agent loop, which refuses every other project
  // type — nothing to configure, so nothing to show. A leftover registration
  // stays visible below so its credentials can still be disconnected.
  if (projectType !== "agent" && !view.configured) {
    return null;
  }

  return (
    <CollapsibleSection
      title={t("pset.teamsBot")}
      badge={
        <Badge color={stateColor(view.enabled)} radius="xl">
          {view.enabled ? "enabled" : view.configured ? "configured (off)" : "not connected"}
        </Badge>
      }
    >
      <Stack gap="sm">
        {projectType !== "agent" && (
          <Alert color="yellow" variant="light" fz="xs">
            Teams messages run the agent loop, and a &quot;{projectType}&quot; project refuses
            them — this bot answers nothing. Disconnect to clear the stored credentials.
          </Alert>
        )}
        <Text fz="xs" c="dimmed" lh={1.6}>
          {t("pset.teamsIntro")}
        </Text>

        <TextInput
          label={t("pset.teamsAppId")}
          value={appId}
          onChange={(e) => setAppId(e.currentTarget.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          styles={monoInput}
        />
        <TextInput
          label={t("pset.teamsAppPassword")}
          value={appPassword}
          onChange={(e) => setAppPassword(e.currentTarget.value)}
          styles={monoInput}
        />
        <TextInput
          label={t("pset.teamsTenantId")}
          value={tenantId}
          onChange={(e) => setTenantId(e.currentTarget.value)}
          placeholder="optional"
          styles={monoInput}
        />
        <Stack gap="xs">
          {confirmModal}
          <Checkbox
            label={t("pset.teamsEnable")}
            checked={enabled}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
          />
          <CopyableUrl url={view.messagingUrl} />
        </Stack>

        {status && (
          <Text fz="sm" c="teal">
            {status}
          </Text>
        )}
        {error && (
          <Text fz="sm" c="red">
            {error}
          </Text>
        )}

        <Group gap="xs">
          <Button onClick={save} loading={busy}>
            Save
          </Button>
          <Button variant="default" onClick={test} disabled={busy || !view.enabled}>
            Test connection
          </Button>
          {view.configured && (
            <Button variant="default" color="red" onClick={disconnect} disabled={busy} ml="auto">
              Disconnect
            </Button>
          )}
        </Group>
      </Stack>
    </CollapsibleSection>
  );
}
