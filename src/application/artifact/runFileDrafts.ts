import type { Artifact } from "@/domain/artifact/types";
import { ConflictError, ValidationError } from "@/application/errors";
import { artifactMetadata, replaceGeneratedArtifact, storeArtifact, type ArtifactContext, type ArtifactInput, type ArtifactStorage } from "./storeArtifact";

/** Bound temporary output from builtins, MCP and delegated Agents together. */
export const MAX_RUN_FILE_DRAFT_BYTES = 100 * 1024 * 1024;
export const MAX_RUN_FILE_DRAFTS = 100;

export interface RunFileDraft {
  artifact: Artifact;
  bytes: Uint8Array;
}
export type ReadRunFile = (id: string) => RunFileDraft | undefined;

export interface PublishedRunFile {
  draftId: string;
  artifact: Artifact;
  replacedArtifactIds: string[];
}

/** Drafts are private to the run. Only the last successful edit of each file is published. */
export function createRunFileDrafts(
  storage: ArtifactStorage,
  context: ArtifactContext,
  failed: (input: ArtifactInput, error: unknown, cleanup?: boolean) => void,
) {
  const drafts = new Map<string, RunFileDraft & { input: ArtifactInput; root: string }>();
  const latest = new Map<string, string>();
  let bytes = 0;

  return {
    read: ((id) => drafts.get(id)) satisfies ReadRunFile,
    stage(input: ArtifactInput): Artifact | undefined {
      try {
        if (drafts.size >= MAX_RUN_FILE_DRAFTS || bytes + input.bytes.byteLength > MAX_RUN_FILE_DRAFT_BYTES) {
          throw new ValidationError("This run exceeded its temporary file budget");
        }
        const artifact = artifactMetadata(context, input);
        if (drafts.has(artifact.artifactId)) throw new ConflictError("File draft identity is already in use");
        const root = input.derivedFrom ? drafts.get(input.derivedFrom)?.root ?? input.derivedFrom : artifact.artifactId;
        drafts.set(artifact.artifactId, { artifact, bytes: input.bytes, input: { ...input, artifactId: artifact.artifactId }, root });
        latest.set(root, artifact.artifactId);
        bytes += input.bytes.byteLength;
        return artifact;
      } catch (error) {
        failed(input, error);
        return undefined;
      }
    },
    async publish(): Promise<PublishedRunFile[]> {
      const published: PublishedRunFile[] = [];
      try {
        for (const [root, id] of latest) {
          const draft = drafts.get(id)!;
          try {
            const result = drafts.has(root)
              ? { artifact: await storeArtifact(storage, context, draft.input) }
              : await replaceGeneratedArtifact(storage, context, draft.input, root);
            const { artifact } = result;
            if (result.cleanupFailure) failed(draft.input, result.cleanupFailure.error, true);
            const replacedArtifactIds = [...drafts.values()]
              .filter(value => value.root === root && value.artifact.artifactId !== id && value.artifact.artifactId !== artifact.artifactId)
              .map(value => value.artifact.artifactId);
            if (result.replacedArtifactId) replacedArtifactIds.push(result.replacedArtifactId);
            published.push({ draftId: id, artifact, replacedArtifactIds: [...new Set(replacedArtifactIds)] });
          } catch (error) {
            failed(draft.input, error);
          }
        }
        return published;
      } finally {
        drafts.clear(); latest.clear(); bytes = 0;
      }
    },
  };
}
