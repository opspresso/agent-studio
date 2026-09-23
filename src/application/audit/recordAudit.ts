/**
 * The one place an audit row is written.
 *
 * Every recorded act goes through `recordAudit`, so the row's shape is decided
 * once. The failure this prevents is the ordinary one: a second recording site
 * spells `target` its own way, and a filter that worked for reveals silently
 * returns nothing for deletions. `tests/architecture.test.ts` pins it.
 *
 * The sink is **pushed in** rather than threaded through every site that
 * records one, for the same reason `setAdminCheck` is: a caller that forgot it would
 * leave exactly one act unrecorded, and an unrecorded act looks identical to one
 * that never happened.
 *
 * `src/instrumentation.ts` wires it on the awaited boot path, before a
 * recording route can serve a request. `src/lib/container.ts` wires it for processes
 * that have no instrumentation hook: the scripts and the integration check
 * compose the container directly.
 *
 * **A failed write is logged, not thrown.** Audit is a record of the act, not a
 * precondition for it — a settings save must not fail because a log row could
 * not be appended, and refusing the act would turn a storage blip into an
 * outage of every sensitive operation at once. The existing `log.warn` lines are
 * deliberately kept alongside for exactly this case: they are what remains when
 * this write is the thing that failed.
 */

import { randomUUID } from "node:crypto";
import type { AuditRepository } from "@/domain/audit/repository";
import type { AuditAction, AuditEvent } from "@/domain/audit/types";
import { log } from "@/shared/logger";

const AUDIT_SINK = Symbol.for("opspresso.agent-studio.audit-sink");

type AuditProcessGlobal = typeof globalThis & { [AUDIT_SINK]?: AuditRepository };

function processGlobal(): AuditProcessGlobal {
  return globalThis as AuditProcessGlobal;
}

/**
 * Wire the store audit rows are appended to. Called once by the composition
 * root. Until it is, `recordAudit` does nothing — a test or a script that never
 * composed the container must not fail on a missing table.
 */
export function setAuditSink(repository: AuditRepository | undefined): void {
  processGlobal()[AUDIT_SINK] = repository;
}

/** Test seam: what is wired right now. */
export function auditSink(): AuditRepository | undefined {
  return processGlobal()[AUDIT_SINK];
}

/**
 * Refuse to boot a server whose audit trail is not connected.
 *
 * The no-op above is right for a test or a script — neither has a table — and
 * wrong for a running server, where it is total: not one row, for the life of
 * the process, with nothing in the log to say so. That is the same failure this
 * module exists to prevent, arriving through the wiring instead of through a
 * second recording site.
 *
 * Boot is the only place it can be caught. `recordAudit` cannot refuse the act
 * it is recording — audit is a record, not a precondition, which is why a failed
 * *write* is logged and swallowed. An unwired sink is not a failed write, it is
 * a structural defect, and `instrumentation.ts` already fails fast on the other
 * guardrails.
 *
 * The sink lives in a `Symbol.for` process slot rather than a module-local
 * variable. Next may evaluate instrumentation and route code from separate
 * server bundles; both copies still read the same sink, so this assertion also
 * proves that route-side recording sees what boot wired.
 */
export function assertAuditSinkWired(): void {
  if (!auditSink()) {
    throw new Error(
      "Audit sink is not wired: recordAudit would silently write nothing for the life of this process.",
    );
  }
}

export interface AuditInput {
  actorEmail: string;
  action: AuditAction;
  target: string;
  detail?: string;
}

/** Append one audit row. Never throws. */
export async function recordAudit(input: AuditInput, now: Date = new Date()): Promise<void> {
  const sink = auditSink();
  if (!sink) {
    return;
  }
  const event: AuditEvent = {
    eventId: randomUUID(),
    actorEmail: input.actorEmail,
    action: input.action,
    target: input.target,
    ...(input.detail ? { detail: input.detail } : {}),
    createdAt: now.toISOString(),
  };
  try {
    await sink.append(event);
  } catch (error) {
    log.error("audit", `could not record ${input.action} on ${input.target}`, error);
  }
}

/** `kind:name`, so a target is spelled the same way at every recording site. */
export function auditTarget(kind: string, name: string): string {
  return `${kind}:${name}`;
}
