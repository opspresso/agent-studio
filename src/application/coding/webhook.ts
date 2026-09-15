import { createHash } from "node:crypto";
import type { WorkspaceRepository } from "@/domain/workspace/repository";
import type { CodingForge } from "@/domain/coding/forge";
import { ConflictError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { isGitHubDeliveryId } from "@/shared/githubWebhook";

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Signed deliveries refresh authoritative PR state only; webhook content never starts a task or approves an effect. */
export async function handleCodingWebhook(repository: WorkspaceRepository, forge: CodingForge, deliveryId: string, raw: string): Promise<{ processed: boolean }> {
  if (!isGitHubDeliveryId(deliveryId)) throw new ValidationError("Invalid GitHub delivery id");
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw new ValidationError("Invalid GitHub webhook JSON"); }
  const branch = field(payload, "pull_request", "head", "ref") ?? field(payload, "workflow_run", "head_branch") ??
    field(payload, "check_suite", "head_branch") ?? field(payload, "check_run", "check_suite", "head_branch");
  if (typeof branch !== "string" || !/^agent\/[a-zA-Z0-9_-]+$/.test(branch)) return { processed: false };
  const id = branch.slice("agent/".length);
  const fingerprint = createHash("sha256").update(raw).digest("hex");
  for (let attempt = 0; attempt < 4; attempt++) {
    const workspace = await repository.get(id);
    const deliveredRepo = field(payload, "repository", "full_name");
    if (!workspace?.coding || workspace.status === "closed" || workspace.deleteRequestedAt ||
      typeof deliveredRepo !== "string" || deliveredRepo.toLowerCase() !== workspace.coding.repository.toLowerCase()) return { processed: false };
    const previous = await repository.delivery(id, deliveryId);
    if (previous) {
      if (previous !== fingerprint) throw new ConflictError("GitHub delivery id was reused with different content");
      return { processed: false };
    }
    const number = workspace.pullRequest?.number ?? field(payload, "pull_request", "number");
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return { processed: false };
    const pullRequest = await forge.pullRequest(workspace.coding, number);
    try {
      await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, revision: workspace.revision + 1, pullRequest },
        delivery: { id: deliveryId, fingerprint } });
      return { processed: true };
    } catch (error) {
      if (!isConditionalWriteFailure(error, { includeTransaction: true })) throw error;
    }
  }
  throw new ConflictError("Workspace changed while recording GitHub delivery");
}
