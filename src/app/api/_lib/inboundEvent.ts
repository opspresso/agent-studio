import { after } from "next/server";
import type { InboundEventClaims } from "@/domain/messaging/inboundClaims";
import { BodyTooLargeError, readBodyText } from "@/shared/httpBody";
import { log, type LogScope } from "@/shared/logger";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { withRunContext } from "@/shared/runContext";

/**
 * The tail every chat-platform webhook shares, once the platform's own
 * verification and gate have run: claim the event exactly once, ack at once,
 * and do the work in the background under the event's own correlation id.
 *
 * Every platform requires a fast ack (Slack within three seconds, Telegram
 * before it retries) and redelivers when it does not get one, so the shape is
 * the same for each — only the id, the claim store and the work differ. What
 * *precedes* this — signature or secret check, the platform's challenge
 * handshake, which events are for the bot — is each adapter's, and deliberately
 * runs ahead of the claim: a message nobody addressed must not cost a write.
 */

/**
 * The request body as text, bounded, or the 413 that says it was not an event.
 */
export async function readEventBody(request: Request, maxBytes: number): Promise<string | Response> {
  try {
    return await readBodyText(request, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return Response.json({ error: "Request body too large" }, { status: 413 });
    }
    throw error;
  }
}

/**
 * Claim the event and schedule its handling; says whether it was a duplicate.
 *
 * `after()` leaves the request's async context, so the correlation scope is
 * opened explicitly with the platform's own event id — the key the dedup claim
 * is written under, so a log line joins the row that says whether it was
 * handled. Settling is bookkeeping for a response that already went out; a
 * failure there leaves the claim to expire on its own rather than escalating.
 */
export async function admitInboundEvent(opts: {
  claims: InboundEventClaims;
  /** The platform's id for the delivery; absent means nothing to deduplicate on. */
  eventId: string | undefined;
  /** The log scope and label the work reports under. */
  scope: LogScope;
  logLabel: string;
  work: () => Promise<void>;
}): Promise<"accepted" | "duplicate"> {
  const { eventId } = opts;
  if (eventId) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!(await opts.claims.claim(eventId, nowSeconds, nowSeconds + RUN_LEASE_SECONDS))) {
      return "duplicate";
    }
  }
  after(() =>
    withRunContext({ runId: eventId ?? `${opts.scope}-event` }, async () => {
      let outcome: "done" | "failed" = "done";
      try {
        await opts.work();
      } catch (error) {
        outcome = "failed";
        log.error(opts.scope, `${opts.logLabel} event handling failed`, error);
      }
      if (!eventId) {
        return;
      }
      try {
        await opts.claims.settle(eventId, outcome);
      } catch (error) {
        log.error(opts.scope, `${opts.logLabel} event settle failed`, error);
      }
    }),
  );
  return "accepted";
}
