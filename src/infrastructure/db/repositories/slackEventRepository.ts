import { keys } from "../keys";
import { createInboundClaimRepository } from "./inboundClaimRepository";

/**
 * Slack redelivers events when the ack is slow, so processing must be
 * idempotent. A conditional put on the event id claims it exactly once — the
 * shared claim-and-settle contract, keyed by Slack's event id.
 */
export const slackEventRepository = createInboundClaimRepository({
  key: keys.slackEvent,
  entityType: "slackEvent",
});
