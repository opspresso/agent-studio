"use client";

import { NavigationLink } from "./NavigationLink";
import interaction from "./InteractiveSurface.module.css";
import { Group, Paper, Stack, Text } from "@mantine/core";
import { IconFileText } from "@tabler/icons-react";
import { isInlineViewable, MAX_INLINE_VIEW_BYTES } from "@/domain/artifact/types";
import { formatBytes } from "@/app/_lib/formatBytes";
import { useT } from "@/app/_i18n/provider";

/**
 * Shared file card with a filename, known byte size and download link.
 * Viewable artifacts also offer the app's isolated preview.
 *
 * Chat can render the card before its address is signed on a finished-turn
 * read. Keep the same shape when the download link arrives; raw chunk routes
 * address files before sending their frames.
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
    <Paper withBorder radius="md" p="md" maw="100%" className={interaction.surface}>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <IconFileText size={20} aria-hidden="true" style={{ flexShrink: 0 }} />
        <Stack gap="xs" style={{ minWidth: 0, flex: 1 }}>
          <div>
            <Text fz="sm" fw={600} style={{ overflowWrap: "anywhere" }}>{name}</Text>
            <Text fz="xs" c="dimmed">
              {size ? `${size}${url ? "" : " · "}` : ""}
              {url ? "" : t("chat.fileWhenDone")}
            </Text>
          </div>
          <Group gap="xs">
            {viewable && <NavigationLink surface href={`/api/artifacts/${artifactId}/view`} newTab>
              {t("artifacts.view")}
            </NavigationLink>}
            {url && <NavigationLink href={url} download={name} surface={!viewable}
              className={viewable ? interaction.control : undefined} label={`${t("artifacts.download")}: ${name}`}>
              {t("artifacts.download")}
            </NavigationLink>}
          </Group>
        </Stack>
      </Group>
    </Paper>
  );
}
