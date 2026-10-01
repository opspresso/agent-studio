import { createHash } from "node:crypto";
import { artifactOwnerEmail } from "@/domain/artifact/types";
import type { Artifact } from "@/domain/artifact/types";
import type { SourceFile } from "@/domain/artifact/sourceFile";

export function contentChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function artifactContentKey(artifact: Pick<Artifact, "agentName" | "actor" | "ownerEmail" | "kind" | "source" | "mimeType">, checksum: string): string {
  // An unresolved actor stays distinct from another actor and from personal files.
  const owner = artifactOwnerEmail(artifact.actor, artifact.ownerEmail) ?? artifact.actor ?? null;
  return createHash("sha256").update(JSON.stringify(["artifact", artifact.agentName, owner,
    artifact.kind, artifact.source, artifact.mimeType.trim().toLowerCase(), checksum])).digest("hex");
}

export function sourceContentKey(file: Pick<SourceFile, "agentName" | "userEmail" | "mimeType" | "retention" | "retainUntil" | "derived">, checksum: string): string {
  return createHash("sha256").update(JSON.stringify(["source-file", file.agentName, file.userEmail,
    file.mimeType.trim().toLowerCase(), file.derived?.kind ?? "attachment", file.retention.unit,
    file.retention.value, file.retention.timezone, file.retainUntil ?? null, checksum])).digest("hex");
}
