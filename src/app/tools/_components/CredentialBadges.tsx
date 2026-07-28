import { Badge } from "@mantine/core";
import { BADGE } from "@/app/_components/badgeColors";
import type { McpServer } from "../api";

/**
 * How an entry can be authenticated, at a glance.
 *
 * Both badges can appear at once, and the order is the order they are tried at
 * dispatch: a project's OAuth connection first, the entry's own headers as the
 * fallback for projects that have not connected. Neither badge means the entry
 * sends no credential at all, which is worth seeing.
 *
 * Colour carries whether a credential is there; the text carries which kind. An
 * entry that sends none is the one worth spotting, so it is the only one that is
 * not green.
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
