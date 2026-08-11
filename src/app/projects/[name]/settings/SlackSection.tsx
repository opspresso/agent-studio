"use client";

import { useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CollapsibleCode } from "@/app/_components/CollapsibleCode";
import { useConfirm } from "@/app/_components/useConfirm";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import {
  disconnectProjectSlack,
  getProjectSlack,
  testProjectSlack,
  updateProjectSlack,
} from "../../lib/api";
import type { ProjectSlackView, SlackSuggestedPrompt } from "../../lib/api";
import { Badge, Button, Checkbox, Group, Stack, Text, TextInput } from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { stateColor } from "@/app/_components/badgeColors";
import { MAX_SUGGESTED_PROMPTS } from "@/domain/slack/types";

/**
 * A fixed grid of empty rows rather than add/remove buttons: Slack takes at
 * most four prompts, so the whole range fits on screen and a blank row is just
 * an unused slot. Blank rows are dropped when saved.
 */
function emptyPrompts(stored: SlackSuggestedPrompt[]): SlackSuggestedPrompt[] {
  return Array.from(
    { length: MAX_SUGGESTED_PROMPTS },
    (_, index) => stored[index] ?? { title: "", message: "" },
  );
}

export function SlackSection({ projectName }: { projectName: string }) {
  const [view, setView] = useState<ProjectSlackView | null>(null);
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [prompts, setPrompts] = useState<SlackSuggestedPrompt[]>(emptyPrompts([]));
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmModal } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    getProjectSlack(projectName)
      .then((v) => {
        if (!cancelled) {
          setView(v);
          setBotToken(v.botToken);
          setSigningSecret(v.signingSecret);
          setEnabled(v.enabled);
          setPrompts(emptyPrompts(v.suggestedPrompts));
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
      const next = await updateProjectSlack(projectName, {
        botToken,
        signingSecret,
        enabled,
        suggestedPrompts: prompts,
      });
      setView(next);
      setBotToken(next.botToken);
      setSigningSecret(next.signingSecret);
      setEnabled(next.enabled);
      setPrompts(emptyPrompts(next.suggestedPrompts));
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
    const result = await testProjectSlack(projectName);
    if (result.ok) {
      setStatus(`Connected: ${result.team} (bot: ${result.botUser})`);
    } else {
      setError(result.error ?? "Connection test failed");
    }
    setBusy(false);
  }

  async function disconnect() {
    if (
      !(await confirm({
        title: "Remove Slack credentials",
        message: "Remove the Slack bot credentials for this project?",
        confirmLabel: "Remove",
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await disconnectProjectSlack(projectName);
      const next = await getProjectSlack(projectName);
      setView(next);
      setBotToken("");
      setSigningSecret("");
      setEnabled(false);
      setPrompts(emptyPrompts([]));
      setStatus("Disconnected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CollapsibleSection
      title="Slack bot"
      badge={
        <Badge color={stateColor(view.enabled)} radius="xl">
          {view.enabled ? "enabled" : view.configured ? "configured (off)" : "not connected"}
        </Badge>
      }
    >
      <Stack gap="sm">
        <Text fz="xs" c="dimmed" lh={1.6}>
          Create a dedicated Slack app for this project from the manifest below (api.slack.com/apps
          → Create New App → From a manifest), install it, then paste the bot token and signing
          secret here.
        </Text>

        <CollapsibleCode
          title="App manifest"
          language="json"
          code={JSON.stringify(view.manifest, null, 2)}
          copyLabel="Copy manifest"
        />

        <TextInput
          label="Bot token"
          value={botToken}
          onChange={(e) => setBotToken(e.currentTarget.value)}
          placeholder="xoxb-…"
          styles={monoInput}
        />
        <TextInput
          label="Signing secret"
          value={signingSecret}
          onChange={(e) => setSigningSecret(e.currentTarget.value)}
          placeholder="Signing secret from Basic Information"
          styles={monoInput}
        />
        <Stack gap="xs">
          {confirmModal}
          <Checkbox
            label="Enable event handling at this URL"
            checked={enabled}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
          />
          <CopyableUrl url={view.eventsUrl} />
        </Stack>

        <Stack gap="xs">
          <Text fz="sm" fw={500}>
            Suggested prompts
          </Text>
          <Text fz="xs" c="dimmed" lh={1.6}>
            Shown when someone opens this app&apos;s assistant pane in Slack. Slack takes up to{" "}
            {MAX_SUGGESTED_PROMPTS}; blank rows are ignored. Changing these also changes the
            manifest above, so re-apply it to the Slack app if you want the new prompts before the
            first event arrives.
          </Text>
          {prompts.map((prompt, index) => (
            <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
              <TextInput
                aria-label={`Prompt ${index + 1} label`}
                placeholder="Label"
                w={180}
                value={prompt.title}
                onChange={(e) => {
                  const title = e.currentTarget.value;
                  setPrompts((current) =>
                    current.map((row, at) => (at === index ? { ...row, title } : row)),
                  );
                }}
              />
              <TextInput
                aria-label={`Prompt ${index + 1} message`}
                placeholder="What clicking it sends"
                style={{ flex: 1 }}
                value={prompt.message}
                onChange={(e) => {
                  const message = e.currentTarget.value;
                  setPrompts((current) =>
                    current.map((row, at) => (at === index ? { ...row, message } : row)),
                  );
                }}
              />
            </Group>
          ))}
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
          <Button variant="default" onClick={test} disabled={busy || !view.configured}>
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
