/**
 * What the A2A protocol says about a task's state — a fact imposed on this
 * app, so it lives in the domain and nowhere else. Terminal and failed subsets
 * are defined once so a protocol revision cannot drift across consumers.
 */

/** A task never transitions away from these; a stored one must not be regressed. */
export const A2A_TERMINAL_STATES = [
  3, // TASK_STATE_COMPLETED
  5, // TASK_STATE_CANCELED
  4, // TASK_STATE_FAILED
  7, // TASK_STATE_REJECTED
] as const;

export type A2aTerminalState = (typeof A2A_TERMINAL_STATES)[number];

export function isTerminalTaskState(state: number): state is A2aTerminalState {
  return (A2A_TERMINAL_STATES as readonly number[]).includes(state);
}

/** Terminal without having answered: the remote's reason is in its status message. */
export function isFailedTaskState(state: number): boolean {
  return state === 4 || state === 7 || state === 5;
}

/** Parked by the remote to ask the caller something; the next message continues it. */
export function awaitsInput(state: number): boolean {
  return state === 6 || state === 8;
}

/** Still running somewhere: neither ended nor waiting for the caller. */
export function isLiveTaskState(state: number): boolean {
  return !isTerminalTaskState(state) && !awaitsInput(state);
}

/** Stable, human-readable state spelling for diagnostics. */
export function taskStateName(state: number): string {
  return [
    "unspecified",
    "submitted",
    "working",
    "completed",
    "failed",
    "canceled",
    "input-required",
    "rejected",
    "auth-required",
  ][state] ?? `unknown-${state}`;
}
