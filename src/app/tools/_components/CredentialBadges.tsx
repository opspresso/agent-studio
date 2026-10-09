"use client";

import { Badge } from "@mantine/core";
import { BADGE } from "@/app/_components/badgeColors";
import { useT } from "@/app/_i18n/provider";
import type { McpServer } from "../api";

/**
 * Registered credential settings. OAuth requires the caller's personal grant;
 * the header badge counts registry defaults. Connection status is checked separately.
 */
export function CredentialBadges({ server }: { server: Pick<McpServer, "headers" | "auth"> }) {
  const t = useT();
  const headerCount = Object.keys(server.headers ?? {}).length;
  const badges: Array<{ text: string; color: string }> = [
    ...(server.auth ? [{ text: "OAuth", color: BADGE.on }] : []),
    ...(headerCount > 0
      ? [{ text: t("tools.headerCount", { count: headerCount }), color: BADGE.on }]
      : []),
  ];
  const shown = badges.length === 0 ? [{ text: t("tools.noCredentials"), color: BADGE.neutral }] : badges;

  return (
    <>
      {shown.map((badge) => (
        <Badge key={badge.text} color={badge.color}>
          {badge.text}
        </Badge>
      ))}
    </>
  );
}
