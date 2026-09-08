import type { SourceReference, SourceReferenceRepository } from "@/domain/artifact/sourceReference";
import { keys } from "../keys";
import { conditions, getItem, transact } from "../store";
import { projectIsLive } from "../projectLifecycle";

export const sourceReferenceRepository: SourceReferenceRepository = {
  async put(reference) {
    await transact([
      { kind: "check", key: keys.project(reference.projectName), condition: projectIsLive },
      { kind: "put", item: { ...keys.sourceReference(reference.id), entityType: "SourceReference",
        reference, expiresAt: reference.expiresAt }, condition: conditions.notExists },
    ]);
  },
  async get(id) {
    const item = await getItem(keys.sourceReference(id));
    return item ? item.reference as SourceReference : null;
  },
};
