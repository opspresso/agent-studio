"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Group, NumberInput, Stack, Text, TextInput } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { stateColor } from "@/app/_components/badgeColors";
import { getProject, updateProject, type CostLimits } from "../../lib/api";

/**
 * Daily and monthly (UTC) spend guards. Four independent thresholds and the
 * channel their notifications go to.
 *
 * An empty field means "no limit" rather than zero — a zero block threshold
 * would refuse every run, which is never what clearing a box is meant to say.
 */
export function CostLimitsSection({ projectName }: { projectName: string }) {
  const [alertUsd, setAlertUsd] = useState<number | "">("");
  const [blockUsd, setBlockUsd] = useState<number | "">("");
  const [monthlyAlertUsd, setMonthlyAlertUsd] = useState<number | "">("");
  const [monthlyBlockUsd, setMonthlyBlockUsd] = useState<number | "">("");
  const [channel, setChannel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getProject(projectName)
      .then((project) => {
        if (cancelled) {
          return;
        }
        const limits = project.costLimits;
        setAlertUsd(limits?.alertThresholdUsd ?? "");
        setBlockUsd(limits?.blockThresholdUsd ?? "");
        setMonthlyAlertUsd(limits?.monthlyAlertThresholdUsd ?? "");
        setMonthlyBlockUsd(limits?.monthlyBlockThresholdUsd ?? "");
        setChannel(limits?.alertSlackChannel ?? "");
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load cost limits");
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
  }, [projectName]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const limits: CostLimits = {
      ...(alertUsd === "" ? {} : { alertThresholdUsd: alertUsd }),
      ...(blockUsd === "" ? {} : { blockThresholdUsd: blockUsd }),
      ...(monthlyAlertUsd === "" ? {} : { monthlyAlertThresholdUsd: monthlyAlertUsd }),
      ...(monthlyBlockUsd === "" ? {} : { monthlyBlockThresholdUsd: monthlyBlockUsd }),
      ...(channel.trim() ? { alertSlackChannel: channel.trim() } : {}),
    };
    try {
      // Both thresholds cleared means the guard is off, which is `null` — not an
      // object holding only a channel that nothing would ever notify on.
      const hasThreshold =
        limits.alertThresholdUsd !== undefined ||
        limits.blockThresholdUsd !== undefined ||
        limits.monthlyAlertThresholdUsd !== undefined ||
        limits.monthlyBlockThresholdUsd !== undefined;
      await updateProject(projectName, { costLimits: hasThreshold ? limits : null });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save cost limits");
    } finally {
      setSaving(false);
    }
  }

  // Readable while collapsed: each configured window as `alert / block` with
  // its period, a dash for a threshold left open, `none` when the guard is off.
  // A monthly-only guard must not read as `– / –`, which says "off".
  const usd = (value: number | "") => (value === "" ? "–" : `$${value}`);
  const windowSummary = (alert: number | "", block: number | "", period: string) =>
    alert === "" && block === "" ? null : `${usd(alert)} / ${usd(block)}${period}`;
  const summary = [
    windowSummary(alertUsd, blockUsd, "/day"),
    windowSummary(monthlyAlertUsd, monthlyBlockUsd, "/mo"),
  ]
    .filter(Boolean)
    .join(" · ");
  const configured = summary !== "";

  return (
    <CollapsibleSection
      title="Cost limits"
      badge={
        loading ? undefined : (
          <Badge color={stateColor(configured)} radius="xl">
            {configured ? summary : "none"}
          </Badge>
        )
      }
    >
      <Stack gap="md">
        <Text fz="sm" c="dimmed">
          Spend is measured per UTC day and per UTC month across every model this project runs.
          Leave a field empty for no limit. A blocked project refuses every run — API, chat,
          Slack and A2A alike — until the window rolls over: 00:00 UTC for the day, the first
          of the next month for the month.
        </Text>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group grow align="flex-start">
          <NumberInput
            label="Alert threshold (USD)"
            description="Notify once a day, keep running"
            value={alertUsd}
            onChange={(value) => setAlertUsd(value === "" ? "" : Number(value))}
            min={0}
            step={1}
            decimalScale={2}
            disabled={loading}
          />
          <NumberInput
            label="Block threshold (USD)"
            description="Refuse runs for the rest of the day"
            value={blockUsd}
            onChange={(value) => setBlockUsd(value === "" ? "" : Number(value))}
            min={0}
            step={1}
            decimalScale={2}
            disabled={loading}
          />
        </Group>
        <Group grow align="flex-start">
          <NumberInput
            label="Monthly alert threshold (USD)"
            description="Notify once a month, keep running"
            value={monthlyAlertUsd}
            onChange={(value) => setMonthlyAlertUsd(value === "" ? "" : Number(value))}
            min={0}
            step={10}
            decimalScale={2}
            disabled={loading}
          />
          <NumberInput
            label="Monthly block threshold (USD)"
            description="Refuse runs for the rest of the month"
            value={monthlyBlockUsd}
            onChange={(value) => setMonthlyBlockUsd(value === "" ? "" : Number(value))}
            min={0}
            step={10}
            decimalScale={2}
            disabled={loading}
          />
        </Group>
        <TextInput
          label="Slack channel id"
          description="Where notifications are posted, using this project's own bot. Without it the thresholds still block."
          placeholder="C0123456789"
          value={channel}
          onChange={(e) => setChannel(e.currentTarget.value)}
          disabled={loading}
        />
        <Group gap="sm">
          <Button onClick={save} loading={saving} disabled={loading}>
            Save cost limits
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
