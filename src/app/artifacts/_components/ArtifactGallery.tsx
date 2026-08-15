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
  Modal,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { IconDownload, IconEye, IconFile, IconTrash } from "@tabler/icons-react";
import { CardGrid } from "@/app/_components/CardGrid";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { useConfirm } from "@/app/_components/useConfirm";
import { formatShortDateTime } from "@/shared/date";
import { formatBytes } from "@/app/_lib/formatBytes";
import { deleteArtifact, type ArtifactPage, type ArtifactQuery, type ArtifactView } from "../api";
import { useLocale, useT } from "@/app/_i18n/provider";

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
  const [preview, setPreview] = useState<ArtifactView | null>(null);
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

      {/*
       * One modal for the page, not one per tile: a grid mounts as many portals
       * as it has cards to show at most one of them.
       *
       * The picture is the subject and the prompt is a caption under it. The
       * prompt used to *be* the title, and `size="auto"` sizes a modal to its
       * content — so a paragraph-long prompt stretched the dialog past the
       * screen and pushed the image out of view, which is the one thing opening
       * it was for. `lineClamp` did not help: it clamps what is drawn, not what
       * the box asks for.
       */}
      <Modal
        opened={preview !== null}
        onClose={() => setPreview(null)}
        title={
          <Text fw={500} lineClamp={1}>
            {preview?.filename ?? t("artifacts.preview")}
          </Text>
        }
        size="auto"
        centered
        // On the dialog rather than on its body, so nothing inside can stretch
        // it — a long filename in the header would otherwise do exactly what the
        // prompt did.
        styles={{ content: { maxWidth: "min(92vw, 60rem)" } }}
      >
        {preview?.url && (
          <Stack gap="sm">
            <Image
              src={preview.url}
              alt={preview.prompt ?? t("artifacts.preview")}
              fit="contain"
              mah="65vh"
              w="auto"
            />
            {preview.prompt && (
              // Its own scroll region rather than the modal's: a long prompt
              // scrolls where it is instead of moving the image off screen.
              <ScrollArea.Autosize mah="18vh" type="auto">
                <Text fz="sm" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
                  {preview.prompt}
                </Text>
              </ScrollArea.Autosize>
            )}
          </Stack>
        )}
      </Modal>

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
            onPreview={() => setPreview(artifact)}
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
  /** Images only — a document's address is signed to download, never to render. */
  onPreview: () => void;
  onDelete: () => void;
}) {
  // A signed URL is minted offline and never checks the object is there, so an
  // expired or already-deleted one fails at fetch time. Saying so beats a broken
  // image icon with no explanation.
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
          {formatBytes(artifact.byteSize)} · {formatShortDateTime(artifact.createdAt, locale)}
        </Text>

        {artifact.producedBy && (
          <Text fz="xs" c="dimmed" truncate>
            by {artifact.producedBy}
          </Text>
        )}

        <Group gap="xs" mt="auto" justify="space-between">
          {/* Two labels because two things happen: an image's address renders, so
              it opens in place; a document's is signed `attachment`, so a browser
              saves it whatever the link says. One word for both was wrong for
              one of them. */}
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
