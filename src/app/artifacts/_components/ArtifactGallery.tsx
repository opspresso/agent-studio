"use client";

/**
 * What runs produced, and the one place they can be removed.
 *
 * Shared by the personal gallery and an agent's tab because the two differ only
 * in which index they read: the rows, the tiles and the delete flow are the same
 * question asked down two axes. The agent list also includes runs whose
 * outputs have no resolved personal owner.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Image,
  SegmentedControl,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  IconDownload,
  IconEye,
  IconFile,
  IconTrash,
} from "@tabler/icons-react";
import { CatalogCollection } from "@/app/_components/CatalogCollection";
import { CatalogViewToggle, useCatalogView } from "@/app/_components/CatalogView";
import rows from "@/app/_components/CatalogRows.module.css";
import classes from "./ArtifactGallery.module.css";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { useImageViewer } from "@/app/_components/ImageViewer";
import { useConfirm } from "@/app/_components/useConfirm";
import { formatShortDateTime } from "@/shared/date";
import { formatBytes } from "@/app/_lib/formatBytes";
import { deleteArtifact, type ArtifactKind, type ArtifactPage, type ArtifactQuery, type ArtifactView } from "../api";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { useLocale, useT } from "@/app/_i18n/provider";
import {
  artifactFileType,
  type ArtifactFileType,
} from "@/app/artifacts/_lib/fileType";
import { isInlineViewable, MAX_INLINE_VIEW_BYTES } from "@/domain/artifact/types";
import { reportError } from "@/app/_lib/reportError";

type KindFilter = "all" | ArtifactKind;

/**
 * The noun the delete sentence puts in the middle of itself.
 *
 * A map rather than a ternary, keyed like `FILE_TYPE_ICONS` below: a ternary's
 * else branch absorbs a third kind silently, so adding one would have the
 * dialog tell somebody deleting an audio file that it removes "the document".
 * Here the compiler asks for the word.
 *
 * Separate from the `artifacts.images`/`artifacts.documents` filter labels,
 * which are plural headings for a segmented control and do not fit a sentence.
 */
const KIND_NOUN: Record<ArtifactKind, MessageKey> = {
  image: "artifacts.kindImage",
  document: "artifacts.kindDocument",
  audio: "artifacts.kindAudio",
};

export function ArtifactGallery({
  load,
  emptyText,
  showAgent = true,
}: {
  load: (query: ArtifactQuery) => Promise<ArtifactPage>;
  emptyText: string;
  /** An agent's own tab already knows whose these are. */
  showAgent?: boolean;
}) {
  const t = useT();
  const [catalogView, setCatalogView] = useCatalogView();
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [filter, setFilter] = useState("");
  const view = useImageViewer();
  const { confirm, confirmModal } = useConfirm();
  // Bumped by every refresh, so a "load more" page that was still in flight
  // when the kind changed cannot append the old kind's rows — or its cursor —
  // to the new list.
  const listGeneration = useRef(0);
  const moreInFlight = useRef(false);

  const query = useCallback(
    (before?: string): ArtifactQuery => ({
      ...(kind === "all" ? {} : { kind }),
      ...(before ? { before } : {}),
    }),
    [kind],
  );

  useEffect(() => {
    // Only the newest request may write. Two kinds picked in a row are two
    // requests in flight, they resolve in arrival order rather than in the
    // order they were asked, and without this the slower first answer lands
    // last — showing the reader a kind they are no longer asking for.
    let cancelled = false;
    listGeneration.current += 1;
    moreInFlight.current = false;
    setArtifacts([]);
    setNextBefore(undefined);
    setLoadingMore(false);
    async function refresh() {
      setLoading(true);
      setError(null);
      try {
        const page = await load(query());
        if (!cancelled) {
          setArtifacts(page.artifacts);
          setNextBefore(page.nextBefore);
        }
      } catch (e) {
        // English on purpose, like every other error in this console: the message
        // that usually lands here is an `AppError`'s, which `application` and
        // `domain` carry as a plain string and cannot translate. A localised
        // fallback beside an English real message is the worse of the two.
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load artifacts");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [load, query]);

  async function loadMore() {
    if (!nextBefore || moreInFlight.current) {
      return;
    }
    const generation = listGeneration.current;
    moreInFlight.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await load(query(nextBefore));
      if (listGeneration.current !== generation) {
        return;
      }
      setArtifacts((current) => [...current, ...page.artifacts]);
      setNextBefore(page.nextBefore);
    } catch (e) {
      if (listGeneration.current === generation) {
        setError(e instanceof Error ? e.message : "Failed to load more");
      }
    } finally {
      if (listGeneration.current === generation) {
        moreInFlight.current = false;
        setLoadingMore(false);
      }
    }
  }

  async function remove(artifact: ArtifactView) {
    const ok = await confirm({
      title: t("artifacts.deleteTitle"),
      // Said before the fact, because it cannot be said after: the transcript
      // that showed this picture keeps its reference, and there is no way to
      // reach back into every chat and Slack thread that rendered it.
      message: t("artifacts.deleteBody", { kind: t(KIND_NOUN[artifact.kind]) }),
      confirmLabel: t("artifacts.delete"),
    });
    if (!ok) {
      return;
    }
    try {
      await deleteArtifact(artifact.artifactId);
      setArtifacts((current) => current.filter((a) => a.artifactId !== artifact.artifactId));
    } catch (e) {
      setError(reportError(e, "Failed to delete"));
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
      artifact.agentName,
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
            { label: t("artifacts.audio"), value: "audio" },
          ]}
        />
        <Group gap="sm">
          {artifacts.length > 0 && (
            <CatalogSearch value={filter} onChange={setFilter} placeholder={t("artifacts.filter")} />
          )}
          <CatalogViewToggle value={catalogView} onChange={setCatalogView} />
        </Group>
      </Group>

      <CatalogCollection view={catalogView} loading={loading} failed={!!error && artifacts.length === 0}
        empty={visible.length === 0} emptyText={artifacts.length === 0 ? emptyText : t("catalog.noResults")}>
        {visible.map((artifact) => (
          <ArtifactEntry
            key={artifact.artifactId}
            artifact={artifact}
            showAgent={showAgent}
            onPreview={() => openPreview(artifact)}
            onDelete={() => void remove(artifact)}
          />
        ))}
      </CatalogCollection>

      {nextBefore && !loading && (
        <Group justify="center">
          <Button variant="default" loading={loadingMore} onClick={() => void loadMore()}>
            {t("artifacts.loadMore")}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function ArtifactEntry({
  artifact,
  showAgent,
  onPreview,
  onDelete,
}: {
  artifact: ArtifactView;
  showAgent: boolean;
  /** Images open in the viewer; inline documents use their sandboxed route. */
  onPreview: () => void;
  onDelete: () => void;
}) {
  // Address resolution never checks the object is there, so an expired or
  // already-deleted one fails at fetch time.
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  const t = useT();
  const locale = useLocale();
  const available = artifact.url !== undefined && artifact.url !== failedUrl;
  const title = artifact.filename ?? artifact.prompt ?? t(KIND_NOUN[artifact.kind]);

  return (
    <article className={classes.entry} aria-label={title}>
      <div className={classes.preview}>
        {artifact.kind === "image" && available ? (
          <UnstyledButton
            type="button"
            aria-label={t("artifacts.view")}
            onClick={onPreview}
            className={classes.imageButton}
          >
            <Image
              src={artifact.url}
              alt={artifact.prompt ?? t("artifacts.imageAlt")}
              h="100%"
              fit="cover"
              onError={() => setFailedUrl(artifact.url)}
            />
          </UnstyledButton>
        ) : (
          <div className={classes.filePreview}><FileTypeIcon artifact={artifact} /></div>
        )}
      </div>

      <div className={classes.identity}>
        <Text className={rows.name} lineClamp={2}>{title}</Text>
        {artifact.source === "attachment" && <Badge variant="light" mt={6}>{t("artifacts.attached")}</Badge>}

        {artifact.prompt && artifact.filename && (
          <Text fz="sm" c="dimmed" lineClamp={2}>
            {artifact.prompt}
          </Text>
        )}

        {!available && <Text fz="xs" c="dimmed" mt={6}>{t("artifacts.unavailable")}</Text>}
      </div>

      <div className={classes.metadata}>
        {showAgent && <Text fz="xs" c="dimmed">{artifact.agentName}</Text>}
        <Text fz="xs" c="dimmed">{formatBytes(artifact.byteSize)} · {formatShortDateTime(artifact.createdAt, locale)}</Text>

        {/* Who drew it and with what. Either half can be missing — a top-level
            run has no subagent to name, and an MCP tool's picture names no
            model — and with neither the line is not rendered at all. */}
        {(artifact.producedBy || artifact.model) && (
          <Text fz="xs" c="dimmed" className={classes.provenance}>
            {[
              artifact.producedBy && t("artifacts.producedBy", { name: artifact.producedBy }),
              artifact.model,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        )}
      </div>

      <Group gap="xs" className={classes.actions}>
        {/* Images render in place; documents are offered as a separate link. */}
        {!available ? (
          <span />
        ) : artifact.kind === "image" ? (
          <Anchor component="button" type="button" onClick={onPreview} fz="sm">
            <Group gap={4}>
              <IconEye size={14} aria-hidden="true" />
              {t("artifacts.view")}
            </Group>
          </Anchor>
        ) : (
          <Group gap="md">
            {/* Opened, not saved — and never at the object's own address:
                `/view` serves it under a sandbox policy, which an S3 URL
                cannot carry. Gated on size as well as type, because the route
                refuses a row past its read limit and only a `SaveFile` row is
                guaranteed under it. Everything else has only a download. */}
            {isInlineViewable(artifact.mimeType) &&
              artifact.byteSize <= MAX_INLINE_VIEW_BYTES && (
              <Anchor
                href={`/api/artifacts/${artifact.artifactId}/view`}
                target="_blank"
                rel="noreferrer"
                fz="sm"
              >
                <Group gap={4}>
                  <IconEye size={14} aria-hidden="true" />
                  {t("artifacts.view")}
                </Group>
              </Anchor>
            )}
            <Anchor href={artifact.url} target="_blank" rel="noreferrer" fz="sm">
              <Group gap={4}>
                <IconDownload size={14} aria-hidden="true" />
                {t("artifacts.download")}
              </Group>
            </Anchor>
          </Group>
        )}
        <ActionIcon variant="subtle" color="red" onClick={onDelete} aria-label={t("artifacts.delete")}>
          <IconTrash size={16} aria-hidden="true" />
        </ActionIcon>
      </Group>
    </article>
  );
}

const FILE_TYPE_ICONS: Partial<Record<ArtifactFileType, string>> = {
  audio: "/icons/file-types/audio.svg",
  pdf: "/icons/file-types/pdf.svg",
  docx: "/icons/file-types/docx.svg",
  pptx: "/icons/file-types/pptx.svg",
  hwpx: "/icons/file-types/hwpx.svg",
  html: "/icons/file-types/html.svg",
  md: "/icons/file-types/md.svg",
  csv: "/icons/file-types/csv.svg",
  txt: "/icons/file-types/txt.svg",
  json: "/icons/file-types/json.svg",
  svg: "/icons/file-types/svg.svg",
};

function FileTypeIcon({ artifact }: { artifact: ArtifactView }) {
  const t = useT();
  const type = artifactFileType(artifact.mimeType, artifact.filename, artifact.key);
  const src = FILE_TYPE_ICONS[type];
  return src ? (
    <Image
      src={src}
      alt={type === "audio" ? t("artifacts.kindAudio") : t("artifacts.documentAlt", { type: type.toUpperCase() })}
      w={64}
      h={64}
      fit="contain"
    />
  ) : (
    <IconFile size={48} opacity={0.4} />
  );
}
