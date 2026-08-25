import { keys } from "./keys";
import { transact, type Condition, type Item } from "./store";

/** The parent row a project-owned child write may land under. */
export const projectIsLive: Condition = (row) =>
  row !== null && row.entityType === "PROJECT" && row.deletingAt === undefined;

/** Write one project-owned child while holding the same lifecycle fence as deletion. */
export async function putProjectItem(
  projectName: string,
  item: Item,
  condition?: Condition,
): Promise<void> {
  await transact([
    { kind: "check", key: keys.project(projectName), condition: projectIsLive },
    { kind: "put", item, ...(condition ? { condition } : {}) },
  ]);
}
