import type { ArtifactContentRepository } from "@/domain/artifact/contentRepository";

/** Boundary fake with real per-key serialization, but no timers or external storage. */
export function fakeArtifactContent(): ArtifactContentRepository {
  const rows = new Map<string, { id: string; kind: "artifact" | "source-file" }>();
  const locks = new Map<string, Promise<void>>();
  return {
    get: async key => rows.get(key) ?? null,
    put: async (key, entry) => { rows.set(key, entry); },
    async exclusive(input, operation) {
      const keys = [...new Set(typeof input === "string" ? [input] : input)].sort();
      const prior = keys.map(key => locks.get(key) ?? Promise.resolve());
      let release!: () => void;
      const next = new Promise<void>(resolve => { release = resolve; });
      for (const key of keys) locks.set(key, next);
      await Promise.all(prior);
      try { return await operation(); }
      finally { release(); for (const key of keys) if (locks.get(key) === next) locks.delete(key); }
    },
  };
}
