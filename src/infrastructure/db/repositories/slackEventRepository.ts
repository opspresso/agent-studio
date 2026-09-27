import { keys } from "../keys";
import { createInboundClaimRepository } from "./inboundClaimRepository";

/**
 * Deduplicate Slack event IDs with the shared claim-and-settle contract.
 * Failed attempts and expired leases may be reclaimed on redelivery.
 */
export const slackEventRepository = createInboundClaimRepository({
  key: keys.slackEvent,
  entityType: "slackEvent",
});
