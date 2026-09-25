"use client";

import { SectionHeading } from "@/app/_components/SectionHeading";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { canEditAgent, useViewer } from "@/app/_lib/useViewer";
import { deleteAgent, getAgent, updateAgent, type SanitizedAgent } from "../../lib/api";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { LoadingText } from "@/app/_components/PageState";
import { useConfirm } from "@/app/_components/useConfirm";
import { CostLimitsSection } from "./CostLimitsSection";
import { VisibilitySection } from "./VisibilitySection";
import { SchedulesSection } from "./SchedulesSection";
import { WebhookSection } from "./WebhookSection";
import { Alert, Button, Group, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";

export default function SettingsPage() {
  const t = useT();
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();

  const viewer = useViewer();
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [departmentCode, setDepartmentCode] = useState("");
  const [agent, setAgent] = useState<SanitizedAgent | null>(null);
  const [loadError, setLoadError] = useState<{ name: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { confirm, confirmModal } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setAgent(null);
    setLoadError(null);
    setError(null);
    setSaved(false);
    async function load() {
      try {
        const agent = await getAgent(name);
        if (!cancelled) {
          setDisplayName(agent.displayName);
          setDescription(agent.description);
          setDepartmentCode(agent.departmentCode ?? "");
          setAgent(agent);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError({ name, message: e instanceof Error ? e.message : "Failed to load agent" });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [name]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateAgent(name, {
        displayName,
        description,
        departmentCode,
      });
      setSaved(true);
    } catch (err) {
      setError(reportError(err, "Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: "Delete agent",
      message: t("pset.deleteConfirm", { name }),
      confirmLabel: "Delete agent",
      requireText: name,
    });
    if (!ok) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await deleteAgent(name);
      router.push("/agents");
    } catch (err) {
      setError(reportError(err, "Failed to delete"));
      setDeleting(false);
    }
  }

  if (agent?.name !== name && loadError?.name !== name) {
    return <LoadingText />;
  }

  if (loadError?.name === name) {
    return (
      <Alert color="red" variant="light" maw={640}>
        {loadError.message}
      </Alert>
    );
  }
  if (!agent) return <LoadingText />;

  if (viewer === null) {
    return <LoadingText />;
  }

  if (!canEditAgent(viewer, agent.ownerEmail)) {
    return (
      <Alert variant="light" color="gray" maw={640}>
        Only the agent owner ({agent.ownerEmail ?? "unknown"}) or an admin can change these settings.
      </Alert>
    );
  }

  // Capped where the playground's form column lands on a wide monitor, so the
  // two tabs of this agent read alike — but in pixels, for the reason the
  // app-settings page carries: a fraction of the row keeps shrinking after the
  // content has run out of room, and nothing here is sharing that row.
  return (
    <Stack gap="lg" maw={860}>
      <SectionHeading title={t("agent.tab.settings")} />
      <form onSubmit={save}>
        <Stack gap="md">
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <TextInput
            label={t("agents.displayName")}
            value={displayName}
            onChange={(e) => setDisplayName(e.currentTarget.value)}
          />
          <Textarea
            label={t("registry.description")}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            autosize
            minRows={4}
            maxRows={20}
            description={t("agents.descriptionHint")}
            inputWrapperOrder={["label", "input", "description", "error"]}
          />
          <TextInput
            label={t("agents.departmentCode")}
            value={departmentCode}
            onChange={(e) => setDepartmentCode(e.currentTarget.value)}
            description={t("agents.departmentHint")}
          />
          <Group gap="sm">
            <Button type="submit" loading={saving}>
              Save changes
            </Button>
            {saved && (
              <Text fz="sm" c="teal">
                Saved
              </Text>
            )}
          </Group>
        </Stack>
      </form>

      <VisibilitySection key={`visibility:${name}`} agentName={name} agent={agent} />

      <CostLimitsSection key={`cost:${name}`} agentName={name} agent={agent} />

      <WebhookSection agentName={name} />

      <SchedulesSection key={`schedules:${name}`} agentName={name} agent={agent} />

      <CollapsibleSection title={t("pset.dangerZone")} danger>
        <Stack gap="sm" align="flex-start">
          <Text fz="sm" c="dimmed">
            {t("pset.deleteHint")}
          </Text>
          <Button variant="default" color="red" onClick={remove} loading={deleting}>
            Delete agent
          </Button>
        </Stack>
      </CollapsibleSection>

      {confirmModal}
    </Stack>
  );
}
