/**
 * What the A2A protocol says about a task's state — a fact imposed on this
 * app, so it lives in the domain and nowhere else. Four modules spelled the
 * terminal set for themselves before this existed, and a fifth spelled the
 * failed subset; identical today, and one revision of the protocol away from
 * drifting.
 */

/** A task never transitions away from these; a stored one must not be regressed. */
export const A2A_TERMINAL_STATES = ["completed", "canceled", "failed", "rejected"] as const;

export type A2aTerminalState = (typeof A2A_TERMINAL_STATES)[number];

export function isTerminalTaskState(state: string): state is A2aTerminalState {
  return (A2A_TERMINAL_STATES as readonly string[]).includes(state);
}

/** Terminal without having answered: the remote's reason is in its status message. */
export function isFailedTaskState(state: string): boolean {
  return state === "failed" || state === "rejected" || state === "canceled";
}

/** Parked by the remote to ask the caller something; the next message continues it. */
export function awaitsInput(state: string): boolean {
  return state === "input-required";
}

/** Still running somewhere: neither ended nor waiting for the caller. */
export function isLiveTaskState(state: string): boolean {
  return !isTerminalTaskState(state) && !awaitsInput(state);
}
