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
import type { ProjectSlackResponse, SlackSuggestedPrompt } from "../../lib/api";
import { Badge, Button, Checkbox, Group, Stack, Text, TextInput } from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { stateColor } from "@/app/_components/badgeColors";
import { MAX_SUGGESTED_PROMPTS } from "@/domain/slack/types";
import { parseList } from "@/shared/parseList";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";

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

export function SlackSection({
  projectName,
}: {
  projectName: string;
}) {
  const t = useT();
  const [view, setView] = useState<ProjectSlackResponse | null>(null);
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [prompts, setPrompts] = useState<SlackSuggestedPrompt[]>(emptyPrompts([]));
  /**
   * Edited as one comma-separated line rather than as rows.
   *
   * Unlike the prompts above there is no fixed number of slots, and a keyword is
   * a single short word — a grid of twenty inputs would be all chrome. The use
   * case owns splitting hairs about the contents: it trims, folds case and drops
   * duplicates, so what comes back may not be what was typed.
   */
  const [keywords, setKeywords] = useState("");
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
          setKeywords(v.channelKeywords.join(", "));
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
        channelKeywords: parseList(keywords),
      });
      setView(next);
      setBotToken(next.botToken);
      setSigningSecret(next.signingSecret);
      setEnabled(next.enabled);
      setPrompts(emptyPrompts(next.suggestedPrompts));
      // What came back, not what was typed — the use case normalized it.
      setKeywords(next.channelKeywords.join(", "));
      setStatus("Saved");
    } catch (e) {
      setError(reportError(e, "Save failed"));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const result = await testProjectSlack(projectName);
      if (result.ok) {
        setStatus(`Connected: ${result.team} (bot: ${result.botUser})`);
      } else {
        setError(result.error ?? "Connection test failed");
      }
    } catch (e) {
      setError(reportError(e, "Connection test failed"));
    } finally {
      setBusy(false);
    }
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
      setError(reportError(e, "Disconnect failed"));
    } finally {
      setBusy(false);
    }
  }


  return (
    <CollapsibleSection
      title={t("pset.slackBot")}
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
          title={t("pset.appManifest")}
          language="json"
          code={JSON.stringify(view.manifest, null, 2)}
          copyLabel="Copy manifest"
        />

        <TextInput
          label={t("pset.botToken")}
          value={botToken}
          onChange={(e) => setBotToken(e.currentTarget.value)}
          placeholder="xoxb-…"
          styles={monoInput}
        />
        <TextInput
          label={t("pset.signingSecret")}
          value={signingSecret}
          onChange={(e) => setSigningSecret(e.currentTarget.value)}
          placeholder={t("pset.signingSecretPlaceholder")}
          styles={monoInput}
        />
        <Stack gap="xs">
          {confirmModal}
          <Checkbox
            label={t("pset.enableEvents")}
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
                placeholder={t("pset.shortcutLabel")}
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
                placeholder={t("pset.shortcutSends")}
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

        <Stack gap="xs">
          <Text fz="sm" fw={500}>
            Channel keywords
          </Text>
          <Text fz="xs" c="dimmed" lh={1.6}>
            Words that wake this bot in a channel without an @mention, separated by commas. Leave
            empty and the bot answers only when it is mentioned — or when someone replies in a
            thread it already answered in, which needs no configuration and lasts a day. Matching
            ignores case and matches inside words, so short or common words wake the bot often.
          </Text>
          <TextInput
            aria-label="Channel keywords"
            placeholder="deploy, incident, 배포"
            value={keywords}
            onChange={(e) => setKeywords(e.currentTarget.value)}
          />
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
