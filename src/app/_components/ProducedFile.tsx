"use client";

import { Anchor, Group, Paper, Stack, Text } from "@mantine/core";
import { IconFileText } from "@tabler/icons-react";
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
 * Shared rather than chat's own, because the Playground and the compare view
 * answer with the same thing: three surfaces drawing one file three ways is how
 * a reader learns the size in one place and not in another.
 */
export function ProducedFile({
  name,
  byteSize,
  url,
}: {
  name: string;
  byteSize?: number | undefined;
  url?: string | undefined;
}) {
  const t = useT();
  const size = byteSize === undefined ? null : formatBytes(byteSize);
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
      </Group>
    </Paper>
  );
}
