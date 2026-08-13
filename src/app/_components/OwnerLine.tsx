"use client";

import { Badge, Group, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { BADGE } from "./badgeColors";

/** Shared owner line: owner email plus a brand-colored "you" badge for the viewer's own items. */
export function OwnerLine({
  ownerEmail,
  isMine,
  prefix,
  mt,
}: {
  ownerEmail: string;
  isMine: boolean;
  prefix?: string;
  /** Spacing above, for the callers that need the line to sit under something. */
  mt?: string | number;
}) {
  const t = useT();
  return (
    <Group gap={6} wrap="nowrap" mt={mt}>
      <Text fz="xs" c="dimmed" truncate>
        {prefix}
        {ownerEmail}
      </Text>
      {isMine && (
        <Badge size="xs" color={BADGE.owned} variant="light">
          {t("common.you")}
        </Badge>
      )}
    </Group>
  );
}
