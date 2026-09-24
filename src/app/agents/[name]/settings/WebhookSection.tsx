"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Select, Stack, Switch, Text, Textarea } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { SecretControl } from "@/app/_components/SecretControl";
import { stateColor } from "@/app/_components/badgeColors";
import { PROJECT_WEBHOOK_ID, projectWebhookPath } from "@/domain/trigger/types";
import { useT } from "@/app/_i18n/provider";
import { TriggerRuns } from "./TriggerRuns";
import {
  createTrigger,
  listTriggerRuns,
  listTriggers,
  revealTriggerSecret,
  updateTrigger,
  type TriggerRun,
  type TriggerView,
} from "../../lib/api";
import { reportError } from "@/app/_lib/reportError";

/**
 * The project's webhook: one address, turned on and off.
 *
 * Nobody names it — `/api/webhook/{project}` is the whole address — so the
 * panel is a switch, and the row it stands for is created the first time the
 * switch goes on. Everything below the switch is what a sender needs to use it:
 * the URL, the secret, how the payload reaches the run, and what recent
 * deliveries did. SecretControl owns reveal, copy, hide and rotation; plaintext
 * is held only in component state until hidden or the page is left.
 */
export function WebhookSection({ projectName }: { projectName: string }) {
  const t = useT();
  const [webhook, setWebhook] = useState<TriggerView | null>(null);
  const [runs, setRuns] = useState<TriggerRun[]>([]);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewScope, setReviewScope] = useState("off");
  const [repositories, setRepositories] = useState("");

  const reload = useCallback(async () => {
    const { triggers } = await listTriggers(projectName);
    // Kind as well as id: a row under the reserved id that is somehow not a
    // webhook has no secret and no delivery URL, and the panel below would
    // offer both.
    const found =
      triggers.find(
        (trigger) => trigger.triggerId === PROJECT_WEBHOOK_ID && trigger.kind === "webhook",
      ) ?? null;
    setWebhook(found);
    setReviewScope(found?.githubReview?.scope ?? "off");
    setRepositories(found?.githubReview?.scope === "repositories" ? found.githubReview.repositories.join("\n") : "");
    setRuns(found ? (await listTriggerRuns(projectName, found.triggerId)).runs : []);
  }, [projectName]);

  useEffect(() => {
    let cancelled = false;
    void reload()
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load the webhook");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (e) {
      setError(reportError(e, "Failed"));
    } finally {
      setBusy(false);
    }
  }

  async function refreshRuns() {
    if (!webhook || busy) return;
    setBusy(true);
    setError(null);
    try {
      setRuns((await listTriggerRuns(projectName, webhook.triggerId)).runs);
    } catch (e) {
      setError(reportError(e, "Failed to refresh webhook runs"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The switch. Turning it on the first time is what creates the row — there is
   * nothing else to configure, so asking anyone to "create a webhook" before
   * they can enable one would be a step with no decision in it.
   */
  function setEnabled(enabled: boolean) {
    void act(async () => {
      if (!webhook) {
        const created = await createTrigger(projectName, { triggerId: PROJECT_WEBHOOK_ID });
        if (created.secret) {
          setRevealed(created.secret);
        }
        return;
      }
      await updateTrigger(projectName, PROJECT_WEBHOOK_ID, { enabled });
    });
  }

  async function secretAction(action: () => Promise<string>): Promise<string> {
    setBusy(true); setError(null);
    try { return await action(); }
    finally { setBusy(false); }
  }

  const url =
    typeof window === "undefined"
      ? projectWebhookPath(projectName)
      : `${window.location.origin}${projectWebhookPath(projectName)}`;

  return (
    <CollapsibleSection
      title={t("webhook.section")}
      // Readable while collapsed, like the token's set/none: whether an outside
      // system can start this project at all, before anyone opens the section.
      badge={
        loading ? undefined : (
          <Badge color={stateColor(webhook?.enabled === true)} radius="xl">
            {webhook?.enabled ? "enabled" : "disabled"}
          </Badge>
        )
      }
    >
      <Stack gap="md">
        <Text fz="sm" c="dimmed">
          {t("webhook.intro")}
        </Text>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <Switch
          label={t("trigger.enabled")}
          checked={webhook?.enabled === true}
          disabled={busy || loading}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
        />

        {webhook && (
          <>
            <CopyableUrl url={url} />
            <Text fz="sm" c="dimmed">{t("webhook.githubHint")}</Text>
            <Select label={t("webhook.reviewMode")} value={reviewScope} allowDeselect={false} disabled={busy}
              onChange={(value) => setReviewScope(value ?? "off")}
              data={[{ value: "off", label: t("webhook.generic") },
                { value: "accessible", label: t("webhook.reviewAccessible") },
                { value: "repositories", label: t("webhook.reviewSelected") }]} />
            {reviewScope !== "off" && <Text size="sm" c="dimmed">{t("webhook.reviewHint")}</Text>}
            {reviewScope === "repositories" && <Textarea label={t("webhook.reviewRepositories")} value={repositories}
              placeholder="owner/repository" minRows={2} disabled={busy} onChange={event => setRepositories(event.currentTarget.value)} />}
            <Button variant="light" disabled={busy} onClick={() => act(async () => {
              await updateTrigger(projectName, PROJECT_WEBHOOK_ID, {
                githubReview: reviewScope === "off" ? null : reviewScope === "accessible" ? { scope: "accessible" }
                  : { scope: "repositories", repositories: repositories.split(/[\n,]/).map(value => value.trim()).filter(Boolean) },
                ...(reviewScope !== "off" ? { allowConcurrent: true } : {}),
              });
            })}>{t("webhook.reviewSave")}</Button>
            <SecretControl key={projectName} label={t("webhook.section")} configured masked={webhook.secretMasked} initialValue={revealed ?? undefined}
              description={t("webhook.secretHint")} disabled={busy}
              onReveal={() => secretAction(() => revealTriggerSecret(projectName, PROJECT_WEBHOOK_ID))}
              onGenerate={() => secretAction(async () => {
                const next = await updateTrigger(projectName, PROJECT_WEBHOOK_ID, { rotateSecret: true });
                if (!next.secret) throw new Error("No webhook secret was returned");
                await reload(); return next.secret;
              })} />

            <Group gap="md" align="flex-end">
              <Switch
                label={t("trigger.allowOverlap")}
                checked={webhook.allowConcurrent}
                disabled={busy}
                mb={8}
                onChange={(e) =>
                  act(async () => {
                    await updateTrigger(projectName, PROJECT_WEBHOOK_ID, {
                      allowConcurrent: e.currentTarget.checked,
                    });
                  })
                }
              />
            </Group>

            <Button variant="subtle" disabled={busy} onClick={() => void refreshRuns()}>{t("webhook.refreshRuns")}</Button>
            <TriggerRuns runs={runs} />
          </>
        )}
      </Stack>
    </CollapsibleSection>
  );
}
