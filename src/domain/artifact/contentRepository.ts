/** Content identities are private to one owner and Agent; entries never extend file lifetime. */
export interface ArtifactContentRepository {
  get(contentKey: string): Promise<{ id: string; kind: "artifact" | "source-file" } | null>;
  put(contentKey: string, entry: { id: string; kind: "artifact" | "source-file"; expiresAt?: string }): Promise<void>;
  /** Serialize lookup and storage across processes, including concurrent uploads. */
  exclusive<T>(contentKey: string, operation: () => Promise<T>): Promise<T>;
}
