import type { SourceReferenceRepository, SourceDownloader, SourceRefresh } from "@/domain/artifact/sourceReference";
import type { AudioJob } from "@/domain/audio/job";
import { audioSourceProject } from "@/domain/audio/job";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import { sourceReferenceContext } from "@/domain/security/secretContext";
import type { createSourceFileUseCases } from "@/application/artifact/sourceFiles";
import { NotFoundError, ValidationError } from "@/application/errors";
import { AudioJobStepError, type AudioJobProcessorDeps } from "./processJob";

const SOURCE_REFERENCE_TTL_SECONDS = 24 * 60 * 60;

export interface SourceReferenceDeps {
  references: SourceReferenceRepository;
  cipher: Pick<SecretCipher, "encrypt" | "decrypt">;
  urlPolicy: UrlPolicy;
  downloader: SourceDownloader;
  files: ReturnType<typeof createSourceFileUseCases>;
  authorize(projectName: string, userEmail: string): Promise<void>;
  refresh?(job: AudioJob, recipe: SourceRefresh, signal: AbortSignal): Promise<{ url: string; namespace: string; itemId: string; filename: string; mimeType: string }>;
  now(): Date;
  id(): string;
}

export function createSourceReferenceUseCases(deps: SourceReferenceDeps) {
  const resolve = async (projectName: string, id: string, userEmail: string) => {
    const reference = await deps.references.get(id);
    if (!reference || reference.projectName !== projectName || reference.userEmail !== userEmail) {
      throw new NotFoundError("Source reference not found");
    }
    if (reference.expiresAt <= Math.floor(deps.now().getTime() / 1000)) throw new AudioJobStepError("source_reference_expired", false);
    return reference;
  };
  return {
    async register(input: { projectName: string; userEmail: string; namespace: string; itemId: string;
      url: string; filename: string; mimeType: string; refresh?: SourceRefresh }) {
      await deps.authorize(input.projectName, input.userEmail);
      if (!input.namespace || input.namespace.length > 128 || !input.itemId || input.itemId.length > 512 ||
        !input.filename.trim() || input.filename.length > 255 || input.url.length > 8192 ||
        !/^[a-z]+\/[a-z0-9.+-]+$/i.test(input.mimeType)) throw new ValidationError("Invalid source reference metadata");
      try { await deps.urlPolicy.assertAllowed(input.url); }
      catch (error) {
        if (!(error instanceof BlockedUrlError)) throw error;
        throw new ValidationError("Source URL is not permitted");
      }
      const id = deps.id();
      await deps.references.put({ id, projectName: input.projectName, userEmail: input.userEmail,
        namespace: input.namespace, itemId: input.itemId, filename: input.filename, mimeType: input.mimeType,
        ...(input.refresh ? { refresh: input.refresh } : {}),
        encryptedUrl: deps.cipher.encrypt(input.url, sourceReferenceContext(input.projectName, id)),
        createdAt: deps.now().toISOString(), expiresAt: Math.floor(deps.now().getTime() / 1000) + SOURCE_REFERENCE_TTL_SECONDS });
      return { sourceRef: id, filename: input.filename, mimeType: input.mimeType };
    },
    async identity(projectName: string, id: string, userEmail: string) {
      await deps.authorize(projectName, userEmail);
      const reference = await resolve(projectName, id, userEmail);
      return { namespace: reference.namespace, itemId: reference.itemId, ...(reference.refresh ? { refresh: reference.refresh } : {}) };
    },
    importFile: (async (job, context) => {
      await deps.authorize(job.projectName, job.userEmail);
      if (job.source.kind === "file") {
        const project = audioSourceProject(job);
        await deps.authorize(project, job.userEmail);
        const file = await deps.files.metadata(project, job.source.fileId, job.userEmail);
        if (file.status !== "ready" || file.retireAt <= deps.now().toISOString()) throw new AudioJobStepError("source_file_expired", false);
        return { fileId: file.id };
      }
      const sourceRef = job.source.sourceRef;
      let refreshed: Awaited<ReturnType<NonNullable<SourceReferenceDeps["refresh"]>>> | undefined;
      const refresh = async () => {
        if (!job.sourceRefresh || !deps.refresh) throw new AudioJobStepError("source_refresh_unavailable", false);
        refreshed ??= await deps.refresh(job, job.sourceRefresh, context.signal);
        if (!job.sourceIdentity || refreshed.namespace !== job.sourceIdentity.namespace || refreshed.itemId !== job.sourceIdentity.itemId) {
          throw new AudioJobStepError("source_identity_changed", false);
        }
        return refreshed;
      };
      let metadata: { filename: string; mimeType: string };
      try { metadata = await deps.files.metadata(job.projectName, `${job.id}-source`, job.userEmail); }
      catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        metadata = job.sourceRefresh ? await refresh() : await resolve(job.projectName, sourceRef, job.userEmail);
      }
      const file = await deps.files.import({ id: `${job.id}-source`, projectName: job.projectName,
        userEmail: job.userEmail, filename: metadata.filename, mimeType: metadata.mimeType, retention: job.retention,
        producedBy: job.producedBy }, async (maxBytes) => {
        let url: string;
        if (job.sourceRefresh) {
          const current = await refresh();
          if (current.mimeType !== metadata.mimeType) throw new AudioJobStepError("source_type_changed", false);
          try { await deps.urlPolicy.assertAllowed(current.url); }
          catch (error) {
            if (!(error instanceof BlockedUrlError)) throw error;
            throw new AudioJobStepError("source_url_refused", false);
          }
          url = current.url;
        } else {
          const reference = await resolve(job.projectName, sourceRef, job.userEmail);
          url = deps.cipher.decrypt(reference.encryptedUrl, sourceReferenceContext(job.projectName, reference.id));
        }
        const downloaded = await deps.downloader.open(url, context.signal, maxBytes);
        return downloaded.body;
      }, context.signal);
      return { fileId: file.id };
    }) satisfies AudioJobProcessorDeps["importFile"],
  };
}
