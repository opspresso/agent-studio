import { keys } from "./keys";
import { transact, type Condition, type Item } from "./store";

/** The parent row an agent-owned child write may land under. */
export const agentIsLive: Condition = (row) =>
  row !== null && row.entityType === "AGENT" && row.deletingAt === undefined;

/** Write one agent-owned child while holding the same lifecycle fence as deletion. */
export async function putAgentItem(
  agentName: string,
  item: Item,
  condition?: Condition,
): Promise<void> {
  await transact([
    { kind: "check", key: keys.agent(agentName), condition: agentIsLive },
    { kind: "put", item, ...(condition ? { condition } : {}) },
  ]);
}
