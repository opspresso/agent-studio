"use client";

import { Badge } from "@mantine/core";
import type { TraceStatus } from "@/domain/trace/types";
import { useT } from "@/app/_i18n/provider";
import { BADGE } from "./badgeColors";

const COLORS: Record<TraceStatus, string> = {
  completed: BADGE.on,
  "awaiting-approval": BADGE.attention,
  "turn-limit": BADGE.attention,
  "output-limit": BADGE.attention,
  failed: BADGE.broken,
  cancelled: BADGE.neutral,
};

/** Trace lists, details and integration history use the same state vocabulary and tone. */
export function TraceStatusBadge({ status }: { status: TraceStatus }) {
  const t = useT();
  return <Badge color={COLORS[status]} title={status}>{t(`trace.status.${status}`)}</Badge>;
}
