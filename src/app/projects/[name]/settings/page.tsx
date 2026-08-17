"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { deleteProject, getProject, updateProject, type ProjectType } from "../../lib/api";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { LoadingText } from "@/app/_components/PageState";
import { useConfirm } from "@/app/_components/useConfirm";
import { A2aSection } from "./A2aSection";
import { CostLimitsSection } from "./CostLimitsSection";
import { SlackSection } from "./SlackSection";
import { TelegramSection } from "./TelegramSection";
import { SchedulesSection } from "./SchedulesSection";
import { WebhookSection } from "./WebhookSection";
import { TokenSection } from "./TokenSection";
import { Alert, Button, Group, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";

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
  const [projectType, setProjectType] = useState<ProjectType>("agent");
  const [loading, setLoading] = useState(true);
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
          setProjectType(project.projectType);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load project");
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
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: "Delete project",
      message: `Deleting "${name}" removes all its versions and usage records. This cannot be undone.`,
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
      router.push("/projects");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setDeleting(false);
    }
  }

  if (loading || viewer === null) {
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
    <Stack gap="xl" maw={760}>
      <form onSubmit={save}>
        <Stack gap="md">
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <TextInput
            label={t("projects.displayName")}
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
          />
          <TextInput
            label={t("projects.departmentCode")}
            value={departmentCode}
            onChange={(e) => setDepartmentCode(e.currentTarget.value)}
            description={t("projects.departmentHint")}
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

      <CostLimitsSection projectName={name} />

      <TokenSection projectName={name} />

      <WebhookSection projectName={name} />

      <SchedulesSection projectName={name} />

      <SlackSection projectName={name} projectType={projectType} />

      <TelegramSection projectName={name} projectType={projectType} />

      <A2aSection projectName={name} />

      <CollapsibleSection title={t("pset.dangerZone")} danger>
        <Stack gap="sm" align="flex-start">
          <Text fz="sm" c="dimmed">
            Deleting a project removes all its versions and usage records.
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
