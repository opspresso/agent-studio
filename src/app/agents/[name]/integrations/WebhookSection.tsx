"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Select, Stack, Switch, Text, Textarea } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { SecretControl } from "@/app/_components/SecretControl";
import { stateColor } from "@/app/_components/badgeColors";
import { AGENT_WEBHOOK_ID, agentWebhookPath } from "@/domain/trigger/types";
import { useT } from "@/app/_i18n/provider";
import {
  createTrigger,
  listTriggers,
  revealTriggerSecret,
  updateTrigger,
  type TriggerView,
} from "../../lib/api";
import { reportError } from "@/app/_lib/reportError";

/**
 * The agent's webhook: one address, turned on and off.
 *
 * Nobody names it — `/api/webhook/{agent}` is the whole address — so the
 * panel is a switch, and the row it stands for is created the first time the
 * switch goes on. Everything below the switch is what a sender needs to use it:
 * the URL, the secret, and how the payload reaches the run. Recent delivery
 * history lives beside the integration list. SecretControl owns reveal, copy, hide and rotation; plaintext
 * is held only in component state until hidden or the page is left.
 */
export function WebhookSection({ agentName, onSelect, selected }: { agentName: string; onSelect?: () => void; selected?: boolean }) {
  const t = useT();
  const [webhook, setWebhook] = useState<TriggerView | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewScope, setReviewScope] = useState("off");
  const [repositories, setRepositories] = useState("");

  const reload = useCallback(async () => {
    const { triggers } = await listTriggers(agentName);
    // Kind as well as id: a row under the reserved id that is somehow not a
    // webhook has no secret and no delivery URL, and the panel below would
    // offer both.
    const found =
      triggers.find(
        (trigger) => trigger.triggerId === AGENT_WEBHOOK_ID && trigger.kind === "webhook",
      ) ?? null;
    setWebhook(found);
    setReviewScope(found?.githubReview?.scope ?? "off");
    setRepositories(found?.githubReview?.scope === "repositories" ? found.githubReview.repositories.join("\n") : "");
  }, [agentName]);

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

  /**
   * The switch. Turning it on the first time is what creates the row — there is
   * nothing else to configure, so asking anyone to "create a webhook" before
   * they can enable one would be a step with no decision in it.
   */
  function setEnabled(enabled: boolean) {
    void act(async () => {
      if (!webhook) {
        const created = await createTrigger(agentName, { triggerId: AGENT_WEBHOOK_ID });
        if (created.secret) {
          setRevealed(created.secret);
        }
        return;
      }
      await updateTrigger(agentName, AGENT_WEBHOOK_ID, { enabled });
    });
  }

  async function secretAction(action: () => Promise<string>): Promise<string> {
    setBusy(true); setError(null);
    try { return await action(); }
    finally { setBusy(false); }
  }

  const url =
    typeof window === "undefined"
      ? agentWebhookPath(agentName)
      : `${window.location.origin}${agentWebhookPath(agentName)}`;

  return (
    <CollapsibleSection
      title={t("webhook.section")}
      onSelect={onSelect}
      selected={selected}
      selectLabel={onSelect ? t("pint.historyView") : undefined}
      // Readable while collapsed, like the token's set/none: whether an outside
      // system can start this agent at all, before anyone opens the section.
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
              await updateTrigger(agentName, AGENT_WEBHOOK_ID, {
                githubReview: reviewScope === "off" ? null : reviewScope === "accessible" ? { scope: "accessible" }
                  : { scope: "repositories", repositories: repositories.split(/[\n,]/).map(value => value.trim()).filter(Boolean) },
                ...(reviewScope !== "off" ? { allowConcurrent: true } : {}),
              });
            })}>{t("webhook.reviewSave")}</Button>
            <SecretControl key={agentName} label={t("webhook.section")} configured masked={webhook.secretMasked} initialValue={revealed ?? undefined}
              description={t("webhook.secretHint")} disabled={busy}
              onReveal={() => secretAction(() => revealTriggerSecret(agentName, AGENT_WEBHOOK_ID))}
              onGenerate={() => secretAction(async () => {
                const next = await updateTrigger(agentName, AGENT_WEBHOOK_ID, { rotateSecret: true });
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
                    await updateTrigger(agentName, AGENT_WEBHOOK_ID, {
                      allowConcurrent: e.currentTarget.checked,
                    });
                  })
                }
              />
            </Group>

          </>
        )}
      </Stack>
    </CollapsibleSection>
  );
}
