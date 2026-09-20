"use client";

import { Anchor, Group, Paper, Stack, Text } from "@mantine/core";
import { IconExternalLink, IconFileText } from "@tabler/icons-react";
import { isInlineViewable, MAX_INLINE_VIEW_BYTES } from "@/domain/artifact/types";
import { formatBytes } from "@/app/_lib/formatBytes";
import { useT } from "@/app/_i18n/provider";

/**
 * A file the run produced, offered as a download.
 *
 * Not a `GeneratedImage` with a different icon: there is nothing to draw, and
 * the reader's whole interaction is deciding whether to fetch it — which is why
 * the size is on the row rather than discovered by clicking.
 *
 * Rendered with no `href` only where the address genuinely arrives later: a
 * chat's is signed when the finished turn is read back, not put on the wire
 * frame by frame. The row keeps its shape across that swap, so the reply does
 * not jump the moment the answer lands. Every other surface reading a run's
 * chunks gets the address on the frame and never draws this state.
 *
 * Chat and Playground share this presentation so filenames, sizes and download
 * links remain consistent across both surfaces.
 */
export function ProducedFile({
  name,
  byteSize,
  url,
  mimeType,
  artifactId,
}: {
  name: string;
  byteSize?: number | undefined;
  url?: string | undefined;
  /** Present where the surface knows it; without it the row is a download. */
  mimeType?: string | undefined;
  /**
   * The artifact row, where the file is one a browser can be shown. Both this
   * and a viewable `mimeType` are needed before the row offers to open it: the
   * address is the app's `/view`, never the object's own, because the sandbox
   * the page runs under is a header only this app can set.
   */
  artifactId?: string | undefined;
}) {
  const t = useT();
  const size = byteSize === undefined ? null : formatBytes(byteSize);
  // Size too, not only type. `/view` refuses a row past its read limit, and the
  // limits only cannot cross for a file `SaveFile` wrote — an MCP tool may hand
  // back ten megabytes with the same mime, and the link would have opened a tab
  // holding a raw JSON 400.
  const viewable =
    artifactId !== undefined &&
    mimeType !== undefined &&
    isInlineViewable(mimeType) &&
    (byteSize === undefined || byteSize <= MAX_INLINE_VIEW_BYTES);
  return (
    <Paper withBorder radius="md" px="md" py="xs" maw="80%">
      <Group gap="xs" wrap="nowrap">
        <IconFileText size={18} />
        <Stack gap={0} style={{ minWidth: 0 }}>
          {url ? (
            <Anchor href={url} download={name} fz="sm" style={{ overflowWrap: "anywhere" }}>
              {name}
            </Anchor>
          ) : (
            <Text fz="sm" style={{ overflowWrap: "anywhere" }}>
              {name}
            </Text>
          )}
          <Text fz={11} c="dimmed">
            {size ? `${size}${url ? "" : " · "}` : ""}
            {url ? "" : t("chat.fileWhenDone")}
          </Text>
        </Stack>
        {viewable && (
          <Anchor
            href={`/api/artifacts/${artifactId}/view`}
            target="_blank"
            rel="noreferrer"
            fz="sm"
            ml="auto"
          >
            <Group gap={4} wrap="nowrap">
              <IconExternalLink size={14} />
              {t("artifacts.view")}
            </Group>
          </Anchor>
        )}
      </Group>
    </Paper>
  );
}
