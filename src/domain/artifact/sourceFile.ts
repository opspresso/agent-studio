import type { FileRetention } from "./retention";

export interface SourceFile {
  id: string;
  agentName: string;
  userEmail: string;
  filename: string;
  mimeType: string;
  retention: FileRetention;
  /** Optional immutable upper bound inherited by derived files from their source. */
  retainUntil?: string;
  derived?: { jobId: string; kind: "checkpoint" | "transcript" | "draft" };
  /** Input Artifact and producing model, preserved when an Agent derives a result. */
  derivedFrom?: string;
  model?: string;
  producedBy?: string;
  revision: number;
  status: "pending" | "ready" | "deleting" | "deleted";
  createdAt: string;
  /** Separate from row TTL: the inventory survives deletion of its bytes. */
  retireAt: string;
  storedAt?: string;
  byteSize?: number;
  checksum?: string;
  deletedAt?: string;
}

export type SourceFileAvailability = "ready" | "missing" | "expired" | "pending" | "deleting" | "deleted";

/** File lifetime is independent of a completed job's retained history. */
export function sourceFileAvailability(file: SourceFile | null, userEmail: string, now: string): SourceFileAvailability {
  if (!file || file.userEmail !== userEmail) return "missing";
  if (file.status !== "ready") return file.status;
  return file.retireAt <= now ? "expired" : "ready";
}

const SOURCE_FILE_PREFIX = "source-files/";
export function sourceFileObjectKey(id: string): string {
  return `${SOURCE_FILE_PREFIX}${encodeURIComponent(id)}`;
}

export function isSourceFileObjectKey(key: string): boolean { return key.startsWith(SOURCE_FILE_PREFIX); }

export interface SourceFileRepository {
  create(file: SourceFile): Promise<SourceFile>;
  get(agentName: string, id: string): Promise<SourceFile | null>;
  finish(file: SourceFile, result: { storedAt: string; retireAt: string; byteSize: number; checksum: string }): Promise<SourceFile | null>;
  expired(now: string, limit: number): Promise<SourceFile[]>;
  forJob(agentName: string, jobId: string, kind: NonNullable<SourceFile["derived"]>["kind"], limit: number): Promise<SourceFile[]>;
  retire(file: SourceFile, now: string): Promise<SourceFile | null>;
  markDeleting(file: SourceFile, now: string): Promise<SourceFile | null>;
  markDeleted(file: SourceFile, now: string): Promise<boolean>;
}
