"use client";

import { SectionHeading } from "@/app/_components/SectionHeading";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { deleteProject, getProject, updateProject } from "../../lib/api";
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
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { confirm, confirmModal } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const project = await getProject(name);
        if (!cancelled) {
          setDisplayName(project.displayName);
          setDescription(project.description);
          setDepartmentCode(project.departmentCode ?? "");
          setOwnerEmail(project.ownerEmail);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Failed to load project");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
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
      await updateProject(name, {
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
      title: "Delete project",
      message: t("pset.deleteConfirm", { name }),
      confirmLabel: "Delete project",
      requireText: name,
    });
    if (!ok) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await deleteProject(name);
      router.push("/agents");
    } catch (err) {
      setError(reportError(err, "Failed to delete"));
      setDeleting(false);
    }
  }

  if (loading) {
    return <LoadingText />;
  }

  if (loadError) {
    return (
      <Alert color="red" variant="light" maw={640}>
        {loadError}
      </Alert>
    );
  }

  if (viewer === null) {
    return <LoadingText />;
  }

  if (!canEditProject(viewer, ownerEmail)) {
    return (
      <Alert variant="light" color="gray" maw={640}>
        Only the project owner ({ownerEmail ?? "unknown"}) or an admin can change these settings.
      </Alert>
    );
  }

  // Capped where the playground's form column lands on a wide monitor, so the
  // two tabs of this project read alike — but in pixels, for the reason the
  // app-settings page carries: a fraction of the row keeps shrinking after the
  // content has run out of room, and nothing here is sharing that row.
  return (
    <Stack gap="lg" maw={860}>
      <SectionHeading title={t("project.tab.settings")} />
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

      <VisibilitySection projectName={name} />

      <CostLimitsSection projectName={name} />

      <WebhookSection projectName={name} />

      <SchedulesSection projectName={name} />

      <CollapsibleSection title={t("pset.dangerZone")} danger>
        <Stack gap="sm" align="flex-start">
          <Text fz="sm" c="dimmed">
            {t("pset.deleteHint")}
          </Text>
          <Button variant="default" color="red" onClick={remove} loading={deleting}>
            Delete project
          </Button>
        </Stack>
      </CollapsibleSection>

      {confirmModal}
    </Stack>
  );
}
