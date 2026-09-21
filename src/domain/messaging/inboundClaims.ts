/**
 * Lease-based admission of an inbound platform event.
 *
 * Every chat platform redelivers when the ack is slow — Slack by event id,
 * Telegram by update id — so processing must be idempotent, and the claim is
 * what makes it so. A claim is a **lease**, not a permanent mark: processing
 * runs in the background after the ack, so an instance that died mid-way must
 * leave something a redelivery can take over rather than an event recorded as
 * handled by nobody. `settle` retires only the lease its caller acquired.
 */
export interface InboundEventClaims {
  /**
   * Claim an event for processing. Returns a new opaque token when this call
   * wins: no prior claim, a failed attempt, or an expired lease. Returns null
   * when the event is done or another instance holds a live lease.
   */
  claim(eventId: string, nowSeconds: number, leaseExpiresAtSeconds: number): Promise<string | null>;
  /**
   * Record how a claimed event finished. `done` retires the claim for good; a
   * `failed` attempt expires the lease immediately so a redelivery can take
   * another run at it rather than being refused as a duplicate of an attempt
   * that produced nothing. Missing, replaced or already settled claims are
   * unchanged; a token can settle only its own still-claimed attempt.
   */
  settle(eventId: string, token: string, outcome: "done" | "failed"): Promise<void>;
}
