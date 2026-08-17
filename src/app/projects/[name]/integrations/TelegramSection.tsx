"use client";

import { useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { useConfirm } from "@/app/_components/useConfirm";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import {
  disconnectProjectTelegram,
  getProjectTelegram,
  registerProjectTelegramWebhook,
  testProjectTelegram,
  updateProjectTelegram,
} from "../../lib/api";
import type { ProjectTelegramView, ProjectType } from "../../lib/api";
import { Alert, Badge, Button, Checkbox, Group, Stack, Text, TextInput } from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { stateColor } from "@/app/_components/badgeColors";
import { useT } from "@/app/_i18n/provider";

export function TelegramSection({
  projectName,
  projectType,
}: {
  projectName: string;
  projectType: ProjectType;
}) {
  const t = useT();
  const [view, setView] = useState<ProjectTelegramView | null>(null);
  const [botToken, setBotToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmModal } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    getProjectTelegram(projectName)
      .then((v) => {
        if (!cancelled) {
          setView(v);
          setBotToken(v.botToken);
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
      const next = await updateProjectTelegram(projectName, { botToken, enabled });
      setView(next);
      setBotToken(next.botToken);
      setEnabled(next.enabled);
      setStatus(next.botUsername ? `Saved — @${next.botUsername}` : "Saved");
      // Saved, but Telegram refused the webhook: said here rather than hidden
      // behind a green "Saved" — the operator has a button to try it again.
      if (next.warnings && next.warnings.length > 0) {
        setError(next.warnings.join(" "));
      }
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
      const result = await testProjectTelegram(projectName);
      setStatus(`Connected: @${result.botUsername ?? result.botId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection test failed");
    } finally {
      setBusy(false);
    }
  }

  async function registerWebhook() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const result = await registerProjectTelegramWebhook(projectName);
      setStatus(`${t("pset.telegramWebhookRegistered")} ${result.url}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Webhook registration failed");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (
      !(await confirm({
        title: "Remove Telegram credentials",
        message: "Remove the Telegram bot token for this project and unregister its webhook?",
        confirmLabel: "Remove",
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await disconnectProjectTelegram(projectName);
      const next = await getProjectTelegram(projectName);
      setView(next);
      setBotToken("");
      setEnabled(false);
      setStatus("Disconnected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  // A Telegram message runs the agent loop, which refuses every other project
  // type — nothing to configure, so nothing to show. A leftover bot stays
  // visible below so its credentials can still be disconnected.
  if (projectType !== "agent" && !view.configured) {
    return null;
  }

  return (
    <CollapsibleSection
      title={t("pset.telegramBot")}
      badge={
        <Badge color={stateColor(view.enabled)} radius="xl">
          {view.enabled ? "enabled" : view.configured ? "configured (off)" : "not connected"}
        </Badge>
      }
    >
      <Stack gap="sm">
        {projectType !== "agent" && (
          <Alert color="yellow" variant="light" fz="xs">
            Telegram messages run the agent loop, and a &quot;{projectType}&quot; project refuses
            them — this bot answers nothing. Disconnect to clear the stored credentials.
          </Alert>
        )}
        <Text fz="xs" c="dimmed" lh={1.6}>
          {t("pset.telegramIntro")}
        </Text>

        <TextInput
          label={t("pset.botToken")}
          value={botToken}
          onChange={(e) => setBotToken(e.currentTarget.value)}
          placeholder="123456789:AA…"
          styles={monoInput}
        />
        {view.botUsername && (
          <Text fz="sm">
            Bot: <Text span ff="monospace">@{view.botUsername}</Text>
          </Text>
        )}
        <Stack gap="xs">
          {confirmModal}
          <Checkbox
            label={t("pset.telegramEnable")}
            checked={enabled}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
          />
          <CopyableUrl url={view.webhookUrl} />
          <Text fz="xs" c="dimmed" lh={1.6}>
            {t("pset.telegramGroupHint")}
          </Text>
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
          <Button variant="default" onClick={registerWebhook} disabled={busy || !view.enabled}>
            {t("pset.telegramRegisterWebhook")}
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
