/**
 * Writing an audit row — the one place that does.
 *
 * Every record point calls {@link recordAudit} and supplies only what it knows
 * (who, what, to what); the id, the timestamp and the retention are stamped
 * here. A second writer is what this exists to prevent: record points get added
 * one at a time, and each one that formats its own row is a row the reader
 * cannot group with the others.
 *
 * **Pushed in, not passed down.** The sink is wired once by the composition
 * root, the same shape as the admin check in `projectUseCases` and for the same
 * reason — a record point is often deep inside a use case that has no business
 * taking a repository just to leave a trail, and an argument any one caller
 * forgot would silently drop exactly the act worth recording.
 *
 * **It never throws.** An audit write failing must not turn a successful reveal
 * into a 500: the caller already did the thing, and failing afterwards would
 * leave the actor believing it did not happen. A failed write is logged loudly
 * instead, which is the fallback trail.
 */

import { randomUUID } from "node:crypto";
import type { AuditEvent, AuditEventInput } from "@/domain/audit/types";
import { log } from "@/shared/logger";

export type AuditSink = (event: AuditEvent) => Promise<void>;

/** Bounded so one caller's error text cannot make a row unwritable. */
const MAX_DETAIL_CHARS = 1_000;

let unwiredWarned = false;

/**
 * Unwired default. It warns rather than silently discarding: a deployment that
 * forgot to wire the sink would otherwise pass every test and keep no trail,
 * which is the failure mode an audit log exists to rule out.
 */
let sink: AuditSink = async (event) => {
  if (!unwiredWarned) {
    unwiredWarned = true;
    log.error("audit", "no audit sink is wired; audit events are being discarded");
  }
  log.warn("audit", `${event.action} ${event.target} by ${event.actorEmail}`);
};

/** Wire the sink. Called once by the composition root. */
export function setAuditSink(next: AuditSink): void {
  sink = next;
  unwiredWarned = false;
}

/**
 * Record one audited act. Awaited by its caller so the row is written before
 * the response goes out, but resolving either way — see the module note.
 */
export async function recordAudit(input: AuditEventInput, now = new Date()): Promise<void> {
  const event: AuditEvent = {
    id: randomUUID(),
    action: input.action,
    actorEmail: input.actorEmail,
    target: input.target,
    ...(input.detail ? { detail: input.detail.slice(0, MAX_DETAIL_CHARS) } : {}),
    createdAt: now.toISOString(),
  };
  try {
    await sink(event);
  } catch (error) {
    log.error(
      "audit",
      `could not record ${event.action} on ${event.target} by ${event.actorEmail}`,
      error,
    );
  }
}
