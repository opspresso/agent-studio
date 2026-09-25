import { keys } from "../keys";
import { createInboundClaimRepository } from "./inboundClaimRepository";

/**
 * The Bot Framework redelivers an activity the endpoint did not answer in
 * time, so processing must be idempotent. The shared claim-and-settle
 * contract, keyed by agent, app and activity id.
 */
export const teamsActivityRepository = {
  forBot: (agentName: string, appId: string) =>
    createInboundClaimRepository({
      key: (activityId) => keys.teamsActivity(agentName, appId, activityId),
      entityType: "teamsActivity",
    }),
};
