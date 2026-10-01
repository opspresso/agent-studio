import type { ArtifactContentRepository } from "@/domain/artifact/contentRepository";

/** Boundary fake with real per-key serialization, but no timers or external storage. */
export function fakeArtifactContent(): ArtifactContentRepository {
  const rows = new Map<string, { id: string; kind: "artifact" | "source-file" }>();
  const locks = new Map<string, Promise<void>>();
  return {
    get: async key => rows.get(key) ?? null,
    put: async (key, entry) => { rows.set(key, entry); },
    async exclusive(key, operation) {
      const prior = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>(resolve => { release = resolve; });
      locks.set(key, next);
      await prior;
      try { return await operation(); }
      finally { release(); if (locks.get(key) === next) locks.delete(key); }
    },
  };
}
