import type { AgentCredential, AgentCredentialPurpose, AgentCredentialRepository } from "@/domain/auth/agentCredential";
import { getItem, transact, type Item } from "../store";
import { keys } from "../keys";
import { agentIsLive } from "../agentLifecycle";
import { AGENT_WEBHOOK_ID, defaultWebhookTrigger } from "@/domain/trigger/types";
import { triggerItem } from "./triggerRepository";

function fromItem(row: Item | null, agentName: string, purpose: AgentCredentialPurpose, tokenId: string): AgentCredential | null {
  if (!row) return null;
  if (row.entityType !== "AGENTCREDENTIAL" || row.purpose !== purpose || row.id !== tokenId || row.agentName !== agentName ||
    typeof row.userId !== "string" || typeof row.token !== "string" || typeof row.masked !== "string" || typeof row.createdAt !== "string") {
    throw new Error("Invalid personal Agent credential record");
  }
  return { id: tokenId, purpose, agentName, userId: row.userId, token: row.token, masked: row.masked, createdAt: row.createdAt };
}

export const agentCredentialRepository: AgentCredentialRepository = {
  async get(agentName, purpose, tokenId) {
    return fromItem(await getItem(keys.agentCredential(agentName, purpose, tokenId)), agentName, purpose, tokenId);
  },
  async forUser(agentName, purpose, userId) {
    const reference = await getItem(keys.agentCredentialUser(agentName, purpose, userId));
    if (!reference) return null;
    if (reference.entityType !== "AGENTCREDENTIALUSER" || reference.purpose !== purpose || reference.agentName !== agentName ||
      reference.userId !== userId || typeof reference.tokenId !== "string" || typeof reference.masked !== "string" || typeof reference.createdAt !== "string") {
      throw new Error("Invalid personal Agent credential reference");
    }
    return { id: reference.tokenId, purpose, agentName, userId, masked: reference.masked, createdAt: reference.createdAt };
  },
  async replace(token, previousTokenId) {
    const { purpose } = token;
    await transact([
      { kind: "check", key: keys.agent(token.agentName), condition: agentIsLive },
      ...(purpose === "webhook" ? [{ kind: "update" as const, key: keys.trigger(token.agentName, AGENT_WEBHOOK_ID),
        condition: (row: Item | null) => row === null || row.kind === "webhook",
        patch: (row: Item | null) => row ?? triggerItem(defaultWebhookTrigger(token.agentName, token.createdAt)) }] : []),
      { kind: "put", item: { ...keys.agentCredentialUser(token.agentName, purpose, token.userId), entityType: "AGENTCREDENTIALUSER",
        purpose, agentName: token.agentName, userId: token.userId, tokenId: token.id, masked: token.masked, createdAt: token.createdAt },
        condition: row => previousTokenId === null ? row === null : row?.tokenId === previousTokenId },
      { kind: "put", item: { ...keys.agentCredential(token.agentName, purpose, token.id), entityType: "AGENTCREDENTIAL", ...token }, condition: row => row === null },
      ...(previousTokenId ? [{ kind: "delete" as const, key: keys.agentCredential(token.agentName, purpose, previousTokenId),
        condition: (row: Item | null) => row?.userId === token.userId && row.purpose === purpose }] : []),
    ]);
  },
  async revoke(agentName, purpose, userId, tokenId) {
    await transact([
      { kind: "check", key: keys.agent(agentName), condition: agentIsLive },
      { kind: "delete", key: keys.agentCredentialUser(agentName, purpose, userId), condition: row => row?.tokenId === tokenId },
      { kind: "delete", key: keys.agentCredential(agentName, purpose, tokenId), condition: row => row?.userId === userId && row.purpose === purpose },
    ]);
  },
};
