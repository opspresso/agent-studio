"use client";

/**
 * What runs produced, and the one place they can be removed.
 *
 * Shared by the personal gallery and a project's tab because the two differ only
 * in which index they read: the rows, the tiles and the delete flow are the same
 * question asked down two axes, and a project's list is the only way rows from a
 * Slack, A2A or trigger run are ever reachable.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Image,
  Paper,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { IconDownload, IconFile, IconTrash } from "@tabler/icons-react";
import { CardGrid } from "@/app/_components/CardGrid";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { useConfirm } from "@/app/_components/useConfirm";
import { formatShortDateTime } from "@/shared/date";
import { deleteArtifact, type ArtifactPage, type ArtifactQuery, type ArtifactView } from "../api";

/** Human-readable size. A gallery is where "why is my bucket big" gets asked. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

type KindFilter = "all" | "image" | "document";

export function ArtifactGallery({
  load,
  emptyText,
  showProject = true,
}: {
  load: (query: ArtifactQuery) => Promise<ArtifactPage>;
  emptyText: string;
  /** A project's own tab already knows whose these are. */
  showProject?: boolean;
}) {
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [filter, setFilter] = useState("");
  const { confirm, confirmModal } = useConfirm();

  const query = useCallback(
    (before?: string): ArtifactQuery => ({
      ...(kind === "all" ? {} : { kind }),
      ...(before ? { before } : {}),
    }),
    [kind],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await load(query());
      setArtifacts(page.artifacts);
      setNextBefore(page.nextBefore);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load artifacts");
    } finally {
      setLoading(false);
    }
  }, [load, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function loadMore() {
    if (!nextBefore) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await load(query(nextBefore));
      setArtifacts((current) => [...current, ...page.artifacts]);
      setNextBefore(page.nextBefore);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }

  async function remove(artifact: ArtifactView) {
    const ok = await confirm({
      title: "Delete artifact",
      // Said before the fact, because it cannot be said after: the transcript
      // that showed this picture keeps its reference, and there is no way to
      // reach back into every chat and Slack thread that rendered it.
      message:
        `This removes the ${artifact.kind} from storage. Anywhere it was shown — a chat message, ` +
        `a Slack thread — will show it as unavailable. This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) {
      return;
    }
    try {
      await deleteArtifact(artifact.artifactId);
      setArtifacts((current) => current.filter((a) => a.artifactId !== artifact.artifactId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  const visible = artifacts.filter((artifact) =>
    matchesFilter(filter, artifact.filename ?? "", artifact.prompt ?? "", artifact.projectName),
  );

  return (
    <Stack gap="lg">
      {confirmModal}

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      <Group justify="space-between" wrap="wrap" gap="sm">
        <SegmentedControl
          value={kind}
          onChange={(value) => setKind(value as KindFilter)}
          data={[
            { label: "All", value: "all" },
            { label: "Images", value: "image" },
            { label: "Documents", value: "document" },
          ]}
        />
        {artifacts.length > 0 && (
          <CatalogSearch value={filter} onChange={setFilter} placeholder="Filter…" />
        )}
      </Group>

      <CardGrid loading={loading} empty={artifacts.length === 0} emptyText={emptyText}>
        {visible.map((artifact) => (
          <ArtifactCard
            key={artifact.artifactId}
            artifact={artifact}
            showProject={showProject}
            onDelete={() => void remove(artifact)}
          />
        ))}
      </CardGrid>

      {nextBefore && !loading && (
        <Group justify="center">
          <Button variant="default" loading={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function ArtifactCard({
  artifact,
  showProject,
  onDelete,
}: {
  artifact: ArtifactView;
  showProject: boolean;
  onDelete: () => void;
}) {
  // A signed URL is minted offline and never checks the object is there, so an
  // expired or already-deleted one fails at fetch time. Saying so beats a broken
  // image icon with no explanation.
  const [gone, setGone] = useState(false);
  const available = artifact.url !== undefined && !gone;

  return (
    <Card h="100%">
      <Card.Section>
        {artifact.kind === "image" && available ? (
          <Image
            src={artifact.url}
            alt={artifact.prompt ?? "Generated image"}
            h={180}
            fit="cover"
            onError={() => setGone(true)}
          />
        ) : (
          <Paper h={180} style={{ display: "grid", placeItems: "center" }}>
            {available ? (
              <IconFile size={40} opacity={0.4} />
            ) : (
              <Text fz="sm" c="dimmed" ta="center" px="md">
                No longer available
              </Text>
            )}
          </Paper>
        )}
      </Card.Section>

      <Stack gap={6} mt="sm" style={{ flex: 1 }}>
        <Group gap="xs" wrap="nowrap" justify="space-between">
          <Text fw={500} truncate>
            {artifact.filename ?? artifact.prompt ?? artifact.kind}
          </Text>
          {artifact.source === "attachment" && <Badge variant="light">Attached</Badge>}
        </Group>

        {artifact.prompt && artifact.filename && (
          <Text fz="sm" c="dimmed" lineClamp={2}>
            {artifact.prompt}
          </Text>
        )}

        <Text fz="xs" c="dimmed">
          {showProject && `${artifact.projectName} · `}
          {formatBytes(artifact.byteSize)} · {formatShortDateTime(artifact.createdAt)}
        </Text>

        {artifact.producedBy && (
          <Text fz="xs" c="dimmed" truncate>
            by {artifact.producedBy}
          </Text>
        )}

        <Group gap="xs" mt="auto" justify="space-between">
          {available ? (
            <Anchor href={artifact.url} target="_blank" rel="noreferrer" fz="sm">
              <Group gap={4}>
                <IconDownload size={14} />
                Open
              </Group>
            </Anchor>
          ) : (
            <span />
          )}
          <ActionIcon variant="subtle" color="red" onClick={onDelete} aria-label="Delete">
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      </Stack>
    </Card>
  );
}
