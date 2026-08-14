"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Code, Group, Select, Stack, Switch, Text } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { CopyButton } from "@/app/_components/CopyButton";
import { useConfirm } from "@/app/_components/useConfirm";
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

/**
 * The project's webhook: one address, turned on and off.
 *
 * Nobody names it — `/api/webhook/{project}` is the whole address — so the
 * panel is a switch, and the row it stands for is created the first time the
 * switch goes on. Everything below the switch is what a sender needs to use it:
 * the URL, the secret, how the payload reaches the run, and what recent
 * deliveries did. The secret is shown in the clear exactly once — on the first
 * enable and on rotation — so the panel keeps it in state until the page is
 * left.
 */
export function WebhookSection({ projectName }: { projectName: string }) {
  const t = useT();
  const [webhook, setWebhook] = useState<TriggerView | null>(null);
  const [runs, setRuns] = useState<TriggerRun[]>([]);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmModal } = useConfirm();

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
      setError(e instanceof Error ? e.message : "Failed");
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
        {confirmModal}
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
            {revealed ? (
              <Alert color="yellow" variant="light" p="sm">
                <Group gap="xs" wrap="nowrap">
                  <Code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{revealed}</Code>
                  <CopyButton text={revealed} />
                  <Button variant="default" size="compact-xs" onClick={() => setRevealed(null)}>
                    Hide
                  </Button>
                </Group>
                <Text fz="xs" mt={4}>
                  Send it as <Code>X-Trigger-Secret</Code>. Anyone holding it can start this
                  project&apos;s published version.
                </Text>
              </Alert>
            ) : (
              <Group gap="xs" wrap="nowrap">
                <Code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                  {webhook.secretMasked}
                </Code>
                <Button
                  variant="default"
                  size="compact-xs"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      setRevealed(await revealTriggerSecret(projectName, PROJECT_WEBHOOK_ID));
                    })
                  }
                >
                  Reveal
                </Button>
              </Group>
            )}

            <Group gap="md" align="flex-end">
              <Select
                label={t("trigger.payload")}
                data={[
                  { value: "message", label: "User message (agent)" },
                  { value: "variables", label: "Template variables (prompt)" },
                ]}
                w={220}
                value={webhook.payloadMode ?? "message"}
                disabled={busy}
                onChange={(value) =>
                  value &&
                  act(async () => {
                    await updateTrigger(projectName, PROJECT_WEBHOOK_ID, {
                      payloadMode: value as "variables" | "message",
                    });
                  })
                }
              />
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

            <Group gap="sm">
              <Button
                variant="default"
                size="xs"
                disabled={busy}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: "Regenerate secret",
                      message:
                        "Regenerate this project's webhook secret? The current secret stops working immediately.",
                      confirmLabel: "Regenerate",
                    }))
                  ) {
                    return;
                  }
                  void act(async () => {
                    const rotated = await updateTrigger(projectName, PROJECT_WEBHOOK_ID, {
                      rotateSecret: true,
                    });
                    if (rotated.secret) {
                      setRevealed(rotated.secret);
                    }
                  });
                }}
              >
                Regenerate secret
              </Button>
            </Group>

            <TriggerRuns runs={runs} />
          </>
        )}
      </Stack>
    </CollapsibleSection>
  );
}
