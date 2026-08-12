"use client";

import { useCallback } from "react";
import { useParams } from "next/navigation";
import { ArtifactGallery } from "@/app/artifacts/_components/ArtifactGallery";
import { listProjectArtifacts, type ArtifactQuery } from "@/app/artifacts/api";

/**
 * Everything this project produced — not a filtered view of the personal
 * gallery. A run started by Slack, a trigger or an A2A call has no mailbox to
 * belong to, so this is the only list those artifacts appear in, and therefore
 * the only place they can be deleted from.
 */
export default function ProjectArtifactsPage() {
  const { name } = useParams<{ name: string }>();
  const load = useCallback(
    (query: ArtifactQuery) => listProjectArtifacts(name, query),
    [name],
  );
  return (
    <ArtifactGallery
      load={load}
      showProject={false}
      emptyText="This project has not produced anything yet."
    />
  );
}
