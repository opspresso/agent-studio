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
import {
  IconDownload,
  IconEye,
  IconFile,
  IconTrash,
} from "@tabler/icons-react";
import { CardGrid } from "@/app/_components/CardGrid";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { useImageViewer } from "@/app/_components/ImageViewer";
import { useConfirm } from "@/app/_components/useConfirm";
import { formatShortDateTime } from "@/shared/date";
import { formatBytes } from "@/app/_lib/formatBytes";
import { deleteArtifact, type ArtifactPage, type ArtifactQuery, type ArtifactView } from "../api";
import { useLocale, useT } from "@/app/_i18n/provider";
import {
  artifactFileType,
  type ArtifactFileType,
} from "@/app/artifacts/_lib/fileType";

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
  const t = useT();
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [filter, setFilter] = useState("");
  const view = useImageViewer();
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

  // Provenance is searchable too: "which of these did gpt-image-1 draw?" is the
  // question the model line exists to answer, and a filter that could not see it
  // would show the answer on every tile while refusing to narrow to it.
  const visible = artifacts.filter((artifact) =>
    matchesFilter(
      filter,
      artifact.filename ?? "",
      artifact.prompt ?? "",
      artifact.projectName,
      artifact.producedBy,
      artifact.model,
    ),
  );

  // The filename is the header and the prompt a caption under the picture,
  // never the title: a paragraph-long prompt there once stretched the dialog
  // past the screen and pushed the image out of view.
  function openPreview(artifact: ArtifactView) {
    if (!artifact.url) {
      return;
    }
    view({
      src: artifact.url,
      alt: artifact.prompt ?? t("artifacts.preview"),
      title: artifact.filename ?? t("artifacts.preview"),
      ...(artifact.prompt ? { caption: artifact.prompt } : {}),
    });
  }

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
            { label: t("artifacts.all"), value: "all" },
            { label: t("artifacts.images"), value: "image" },
            { label: t("artifacts.documents"), value: "document" },
          ]}
        />
        {artifacts.length > 0 && (
          <CatalogSearch value={filter} onChange={setFilter} placeholder={t("artifacts.filter")} />
        )}
      </Group>

      <CardGrid loading={loading} empty={artifacts.length === 0} emptyText={emptyText}>
        {visible.map((artifact) => (
          <ArtifactCard
            key={artifact.artifactId}
            artifact={artifact}
            showProject={showProject}
            onPreview={() => openPreview(artifact)}
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
  onPreview,
  onDelete,
}: {
  artifact: ArtifactView;
  showProject: boolean;
  /** Images only — a document is offered as a download, never rendered. */
  onPreview: () => void;
  onDelete: () => void;
}) {
  // Address resolution never checks the object is there, so an expired or
  // already-deleted one fails at fetch time.
  const [gone, setGone] = useState(false);
  const t = useT();
  const locale = useLocale();
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
            onClick={onPreview}
            style={{ cursor: "pointer" }}
            onError={() => setGone(true)}
          />
        ) : (
          <Paper h={180} style={{ display: "grid", placeItems: "center" }}>
            {available ? (
              <FileTypeIcon artifact={artifact} />
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
          {formatBytes(artifact.byteSize)} · {formatShortDateTime(artifact.createdAt, locale)}
        </Text>

        {/* Who drew it and with what. Either half can be missing — a top-level
            run has no subagent to name, and an MCP tool's picture names no
            model — and with neither the line is not rendered at all. */}
        {(artifact.producedBy || artifact.model) && (
          <Text fz="xs" c="dimmed" truncate>
            {[artifact.producedBy && `by ${artifact.producedBy}`, artifact.model]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        )}

        <Group gap="xs" mt="auto" justify="space-between">
          {/* Images render in place; documents are offered as a separate link. */}
          {!available ? (
            <span />
          ) : artifact.kind === "image" ? (
            <Anchor component="button" type="button" onClick={onPreview} fz="sm">
              <Group gap={4}>
                <IconEye size={14} />
                View
              </Group>
            </Anchor>
          ) : (
            <Anchor href={artifact.url} target="_blank" rel="noreferrer" fz="sm">
              <Group gap={4}>
                <IconDownload size={14} />
                Download
              </Group>
            </Anchor>
          )}
          <ActionIcon variant="subtle" color="red" onClick={onDelete} aria-label={t("artifacts.delete")}>
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      </Stack>
    </Card>
  );
}

const FILE_TYPE_ICONS: Partial<Record<ArtifactFileType, string>> = {
  pdf: "/icons/file-types/pdf.svg",
  docx: "/icons/file-types/docx.svg",
  pptx: "/icons/file-types/pptx.svg",
  hwpx: "/icons/file-types/hwpx.svg",
};

function FileTypeIcon({ artifact }: { artifact: ArtifactView }) {
  const type = artifactFileType(artifact.mimeType, artifact.filename, artifact.key);
  const src = FILE_TYPE_ICONS[type];
  return src ? (
    <Image src={src} alt={`${type.toUpperCase()} document`} w={64} h={64} fit="contain" />
  ) : (
    <IconFile size={48} opacity={0.4} />
  );
}
