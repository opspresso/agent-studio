"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Divider, Group, Select, Switch, Text, Textarea } from "@mantine/core";
import { AGENT_WEBHOOK_ID } from "@/domain/trigger/types";
import { useT } from "@/app/_i18n/provider";
import {
  listTriggers,
  updateTrigger,
  type TriggerView,
} from "../../lib/api";
import { reportError } from "@/app/_lib/reportError";
import { TokenSection } from "./TokenSection";

/** Personal invocation credentials and owner-managed behavior share one Webhook section. */
export function WebhookSection({ agentName, onSelect, selected, canManage = true }: { agentName: string; onSelect?: () => void; selected?: boolean; canManage?: boolean }) {
  const t = useT();
  const [webhook, setWebhook] = useState<TriggerView | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenVersion, setTokenVersion] = useState(0);
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
    if (!canManage) { setLoading(false); return; }
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
  }, [reload, canManage, tokenVersion]);

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

  return (
    <TokenSection
      agentName={agentName}
      purpose="webhook"
      onSelect={onSelect}
      selected={selected}
      onChange={() => setTokenVersion(version => version + 1)}
    >
        {canManage && <>
        <Divider />
        <Text fz="sm" c="dimmed">
          {t("webhook.intro")}
        </Text>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        {!loading && webhook && (
          <>
            {webhook.reviewIssue && <Alert color="yellow" title={t("webhook.reviewSetupRequired")}>
              {webhook.reviewIssue}
            </Alert>}
            <Select label={t("webhook.reviewMode")} value={reviewScope} allowDeselect={false} disabled={busy}
              onChange={(value) => setReviewScope(value ?? "off")}
              data={[{ value: "off", label: t("webhook.generic") },
                { value: "accessible", label: t("webhook.reviewAccessible") },
                { value: "repositories", label: t("webhook.reviewSelected") }]} />
            {reviewScope !== "off" && <>
              <Text size="sm" c="dimmed">{t("webhook.reviewHint")}</Text>
            </>}
            {reviewScope === "repositories" && <Textarea label={t("webhook.reviewRepositories")} value={repositories}
              placeholder="owner/repository" minRows={2} disabled={busy} onChange={event => setRepositories(event.currentTarget.value)} />}
            <Button variant="light" disabled={busy} onClick={() => act(async () => {
              await updateTrigger(agentName, AGENT_WEBHOOK_ID, {
                githubReview: reviewScope === "off" ? null : reviewScope === "accessible" ? { scope: "accessible" }
                  : { scope: "repositories", repositories: repositories.split(/[\n,]/).map(value => value.trim()).filter(Boolean) },
              });
            })}>{t("webhook.reviewSave")}</Button>
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
        </>}
    </TokenSection>
  );
}
