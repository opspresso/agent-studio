import type { ArtifactContentRepository } from "@/domain/artifact/contentRepository";
import { keys } from "../keys";
import { getItem, putItem } from "../store";
import { withContentLock } from "../client";
import { expiresAtSeconds, isExpired, RETENTION } from "../ttl";

export const artifactContentRepository: ArtifactContentRepository = {
  async get(contentKey) {
    const row = await getItem(keys.artifactContent(contentKey));
    if (!row || isExpired(row.expiresAt, Date.now())) return null;
    return { id: row.id as string, kind: row.kind as "artifact" | "source-file" };
  },
  async put(contentKey, entry) {
    await putItem({ ...keys.artifactContent(contentKey), entityType: "ArtifactContent",
      id: entry.id, kind: entry.kind, expiresAt: entry.expiresAt ? Math.floor(Date.parse(entry.expiresAt) / 1000)
        : expiresAtSeconds(new Date().toISOString(), RETENTION.artifactDays) });
  },
  async exclusive(contentKey, operation) {
    return withContentLock(contentKey, operation);
  },
};
