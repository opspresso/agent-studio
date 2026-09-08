import type { SourceFile, SourceFileRepository } from "@/domain/artifact/sourceFile";
import { keys } from "../keys";
import { conditions, getItem, queryItems, transact, updateItem,
  CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED, type Item } from "../store";

function value(item: Item | null): SourceFile | null { return item ? item.file as SourceFile : null; }
function row(file: SourceFile): Item {
  return { ...keys.sourceFile(file.id), entityType: "SourceFile", file,
    ...(file.status !== "deleted" ? keys.sourceFileExpiryIndex(file.retireAt, file.projectName, file.id) : {}) };
}
function lostCondition(error: unknown) {
  return error instanceof Error && [CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED].includes(error.name);
}

export const sourceFileRepository: SourceFileRepository = {
  async create(file) {
    try {
      await transact([
        { kind: "check", key: keys.project(file.projectName), condition: conditions.exists },
        { kind: "put", item: row(file), condition: conditions.notExists },
      ]);
      return file;
    } catch (error) {
      if (!lostCondition(error)) throw error;
      const existing = await this.get(file.projectName, file.id);
      if (!existing) throw error;
      return existing;
    }
  },
  async get(projectName, id) {
    const file = value(await getItem(keys.sourceFile(id)));
    return file?.projectName === projectName ? file : null;
  },
  async finish(file, result) {
    try {
      const updated = await updateItem(keys.sourceFile(file.id), () => row({
        ...file, ...result, revision: file.revision + 1, status: "ready",
      }), (item) => value(item)?.status === "pending" && value(item)?.revision === file.revision);
      return value(updated.after);
    } catch (error) { if (lostCondition(error)) return null; throw error; }
  },
  async expired(now, limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Source expiry limit must be 1–100");
    return (await queryItems({ index: "GSI1", ...keys.sourceFileExpiryQuery(now), limit })).map((item) => value(item)!);
  },
  async markDeleting(file, now) {
    try {
      const updated = await updateItem(keys.sourceFile(file.id), () => row({
        ...file, revision: file.revision + 1, status: "deleting",
      }), (item) => {
        const current = value(item);
        return current !== null && current.revision === file.revision && current.status !== "deleted" && current.retireAt <= now;
      });
      return value(updated.after);
    } catch (error) { if (lostCondition(error)) return null; throw error; }
  },
  async markDeleted(file, now) {
    try {
      await updateItem(keys.sourceFile(file.id), () => row({
        ...file, revision: file.revision + 1, status: "deleted", deletedAt: now,
      }), (item) => value(item)?.status === "deleting" && value(item)?.revision === file.revision);
      return true;
    } catch (error) { if (lostCondition(error)) return false; throw error; }
  },
};
