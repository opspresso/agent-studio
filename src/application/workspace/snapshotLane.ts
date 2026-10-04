/** Bound process memory before checkpoint bytes are loaded, encoded or encrypted. */
const SNAPSHOT_CONCURRENCY = 2;
const SNAPSHOT_SLOT = Symbol.for("opspresso.agent-studio.workspace-snapshot-lane");
const scope = globalThis as typeof globalThis & { [SNAPSHOT_SLOT]?: { active: number; waiting: Array<() => void> } };
const state = scope[SNAPSHOT_SLOT] ??= { active: 0, waiting: [] };

export async function withWorkspaceSnapshot<T>(operation: () => Promise<T>): Promise<T> {
  await new Promise<void>(resolve => {
    const enter = () => { state.active += 1; resolve(); };
    if (state.active < SNAPSHOT_CONCURRENCY) enter();
    else state.waiting.push(enter);
  });
  try { return await operation(); }
  finally { state.active -= 1; state.waiting.shift()?.(); }
}
