"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { formatDateTime } from "@/shared/date";
import {
  deleteVersion,
  getProject,
  listVersions,
  publishVersion,
  type Version,
} from "../../lib/api";
import { Alert, Badge, Button, Card, Group, Stack, Text } from "@mantine/core";

export default function VersionsPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;

  const viewer = useViewer();
  const [versions, setVersions] = useState<Version[]>([]);
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [published, setPublished] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [project, vers] = await Promise.all([getProject(name), listVersions(name)]);
      setPublished(project.publishedVersion);
      setOwnerEmail(project.ownerEmail);
      setVersions([...vers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load versions");
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function publish(versionName: string) {
    setBusy(versionName);
    setError(null);
    try {
      const project = await publishVersion(name, versionName);
      setPublished(project.publishedVersion);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to publish");
    } finally {
      setBusy(null);
    }
  }

  async function remove(versionName: string) {
    if (!confirm(`Delete version ${versionName}?`)) {
      return;
    }
    setBusy(versionName);
    setError(null);
    try {
      await deleteVersion(name, versionName);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <Text fz="sm" c="dimmed">
        Loading…
      </Text>
    );
  }

  return (
    <Stack gap="md">
      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {versions.length === 0 ? (
        <Text fz="sm" c="dimmed">
          No versions yet. Create one in the Playground tab.
        </Text>
      ) : (
        <Card padding={0}>
          {versions.map((version, index) => {
            const isPublished = published === version.versionName;
            return (
              <Group
                key={version.versionName}
                justify="space-between"
                gap="md"
                px="md"
                py="sm"
                wrap="nowrap"
                style={
                  index > 0
                    ? { borderTop: "1px solid var(--mantine-color-default-border)" }
                    : undefined
                }
              >
                <div>
                  <Group gap="xs">
                    <Text ff="monospace" fz="sm" fw={500}>
                      v{version.versionName}
                    </Text>
                    {isPublished && <Badge color="teal">published</Badge>}
                  </Group>
                  <Text fz="xs" c="dimmed" mt={2}>
                    {version.model} · {formatDateTime(version.createdAt)}
                  </Text>
                </div>
                {canEditProject(viewer, ownerEmail) && (
                  <Group gap="xs" wrap="nowrap">
                    <Button
                      variant="default"
                      onClick={() => publish(version.versionName)}
                      disabled={busy !== null || isPublished}
                    >
                      {isPublished ? "Published" : "Publish"}
                    </Button>
                    <Button
                      variant="default"
                      color="red"
                      onClick={() => remove(version.versionName)}
                      disabled={busy !== null}
                    >
                      Delete
                    </Button>
                  </Group>
                )}
              </Group>
            );
          })}
        </Card>
      )}
    </Stack>
  );
}
