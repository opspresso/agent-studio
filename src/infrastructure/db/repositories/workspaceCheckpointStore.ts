import { createHash } from "node:crypto";
import type { WorkspaceCheckpointStore } from "@/domain/workspace/ports";
import type { Workspace } from "@/domain/workspace/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { workspaceCheckpointContext } from "@/domain/security/secretContext";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { keys } from "../keys";
import { conditions, deletePartition, getItem, transact } from "../store";
import { expiresAtSeconds, isExpired, RETENTION } from "../ttl";

/** Chunked, context-bound encryption keeps native state out of API views and ordinary event rows. */
export function createWorkspaceCheckpointStore(cipher: Pick<SecretCipher, "encrypt" | "decrypt">): WorkspaceCheckpointStore {
  return {
    async put(workspaceId, checkpointId, bytes, createdAt) {
      if (bytes.byteLength > WORKSPACE_LIMITS.checkpointBytes) throw new Error("Workspace checkpoint exceeds storage limit");
      const size = WORKSPACE_LIMITS.checkpointChunkBytes;
      const count = Math.ceil(bytes.byteLength / size);
      const expiresAt = expiresAtSeconds(createdAt, RETENTION.workspaceDays);
      const check = {
        kind: "check" as const, key: keys.workspace(workspaceId), condition: (row: Record<string, unknown> | null) => {
          const workspace = row?.value as Workspace | undefined;
          return !!workspace && workspace.status !== "closed" && !workspace.deleteRequestedAt && !isExpired(row?.expiresAt, Date.now());
        },
      };
      for (let index = 0; index < count; index++) {
        const chunk = Buffer.from(bytes.subarray(index * size, (index + 1) * size)).toString("base64");
        await transact([check, { kind: "put", item: {
          ...keys.workspaceCheckpointChunk(workspaceId, checkpointId, index), expiresAt,
          encrypted: cipher.encrypt(chunk, workspaceCheckpointContext(workspaceId, checkpointId, index)),
        }, condition: conditions.notExists }]);
      }
      await transact([check, { kind: "put", item: { ...keys.workspaceCheckpoint(workspaceId, checkpointId),
        count, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), expiresAt,
      }, condition: conditions.notExists }]);
    },
    async get(workspaceId, checkpointId) {
      const manifest = await getItem(keys.workspaceCheckpoint(workspaceId, checkpointId));
      if (!manifest || isExpired(manifest.expiresAt, Date.now())) return null;
      const count = manifest.count as number;
      const byteLength = manifest.byteLength as number;
      if (!Number.isSafeInteger(count) || count < 0 || count > Math.ceil(WORKSPACE_LIMITS.checkpointBytes / WORKSPACE_LIMITS.checkpointChunkBytes) ||
        !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > WORKSPACE_LIMITS.checkpointBytes ||
        count !== Math.ceil(byteLength / WORKSPACE_LIMITS.checkpointChunkBytes)) {
        throw new Error("Invalid workspace checkpoint manifest");
      }
      const chunks: Buffer[] = [];
      for (let index = 0; index < count; index++) {
        const chunk = await getItem(keys.workspaceCheckpointChunk(workspaceId, checkpointId, index));
        if (!chunk || isExpired(chunk.expiresAt, Date.now()) || typeof chunk.encrypted !== "string") {
          throw new Error("Workspace checkpoint is incomplete");
        }
        const plain = cipher.decrypt(chunk.encrypted, workspaceCheckpointContext(workspaceId, checkpointId, index));
        const decoded = Buffer.from(plain, "base64");
        if (decoded.byteLength > WORKSPACE_LIMITS.checkpointChunkBytes) throw new Error("Invalid workspace checkpoint chunk");
        chunks.push(decoded);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.byteLength !== byteLength || createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
        throw new Error("Workspace checkpoint integrity mismatch");
      }
      return bytes;
    },
    async delete(workspaceId) { await deletePartition(keys.workspaceStatePartition(workspaceId)); },
  };
}
