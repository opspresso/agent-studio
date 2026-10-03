import { Badge } from "@mantine/core";
import { BADGE } from "@/app/_components/badgeColors";
import type { McpServer } from "../api";

/**
 * Registered credential settings. OAuth requires the caller's personal grant;
 * the header badge counts registry defaults. Connection status is checked separately.
 */
export function CredentialBadges({ server }: { server: McpServer }) {
  const headerCount = Object.keys(server.headers ?? {}).length;
  const badges: Array<{ text: string; color: string }> = [
    ...(server.auth ? [{ text: "OAuth", color: BADGE.on }] : []),
    ...(headerCount > 0
      ? [{ text: `${headerCount} header${headerCount === 1 ? "" : "s"}`, color: BADGE.on }]
      : []),
  ];
  const shown = badges.length === 0 ? [{ text: "no credential", color: BADGE.attention }] : badges;

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
