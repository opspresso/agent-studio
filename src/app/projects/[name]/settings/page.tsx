"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { deleteProject, getProject, updateProject } from "../../lib/api";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { A2aSection } from "./A2aSection";
import { CostLimitsSection } from "./CostLimitsSection";
import { SlackSection } from "./SlackSection";
import { TriggersSection } from "./TriggersSection";
import { TokenSection } from "./TokenSection";
import { Alert, Button, Group, Stack, Text, Textarea, TextInput } from "@mantine/core";

export default function SettingsPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();

  const viewer = useViewer();
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const project = await getProject(name);
        if (!cancelled) {
          setDisplayName(project.displayName);
          setDescription(project.description);
          setOwnerEmail(project.ownerEmail);
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
      await updateProject(name, { displayName, description });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete project "${name}" and all its versions? This cannot be undone.`)) {
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
    return (
      <Text fz="sm" c="dimmed">
        Loading…
      </Text>
    );
  }

  if (!canEditProject(viewer, ownerEmail)) {
    return (
      <Alert variant="light" color="gray" maw={640}>
        Only the project owner ({ownerEmail ?? "unknown"}) or an admin can change these settings.
      </Alert>
    );
  }

  return (
    <Stack gap="xl" maw={640}>
      <form onSubmit={save}>
        <Stack gap="md">
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <TextInput
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.currentTarget.value)}
          />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            autosize
            minRows={4}
            maxRows={20}
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

      <TriggersSection projectName={name} />

      <SlackSection projectName={name} />

      <A2aSection projectName={name} />

      <CollapsibleSection title="Danger zone" danger>
        <Stack gap="sm" align="flex-start">
          <Text fz="sm" c="dimmed">
            Deleting a project removes all its versions and usage records.
          </Text>
          <Button variant="default" color="red" onClick={remove} loading={deleting}>
            Delete project
          </Button>
        </Stack>
      </CollapsibleSection>
    </Stack>
  );
}
