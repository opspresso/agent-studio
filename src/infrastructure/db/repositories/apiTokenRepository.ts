import type { ApiToken, ApiTokenRepository } from "@/domain/auth/apiToken";
import { getItem, transact, type Item } from "../store";
import { keys } from "../keys";
import { agentIsLive } from "../agentLifecycle";

function fromItem(row: Item | null, agentName: string, tokenId: string): ApiToken | null {
  if (!row) return null;
  if (row.entityType !== "APITOKEN" || row.id !== tokenId || row.agentName !== agentName || typeof row.userId !== "string" ||
    typeof row.token !== "string" || typeof row.masked !== "string" || typeof row.createdAt !== "string") throw new Error("Invalid personal API token record");
  return { id: tokenId, agentName, userId: row.userId, token: row.token, masked: row.masked, createdAt: row.createdAt };
}

export const apiTokenRepository: ApiTokenRepository = {
  async get(agentName, tokenId) { return fromItem(await getItem(keys.agentApiToken(agentName, tokenId)), agentName, tokenId); },
  async forUser(agentName, userId) {
    const reference = await getItem(keys.agentApiTokenUser(agentName, userId));
    if (!reference) return null;
    if (reference.entityType !== "APITOKENUSER" || reference.agentName !== agentName || reference.userId !== userId || typeof reference.tokenId !== "string") throw new Error("Invalid personal API token reference");
    if (typeof reference.masked !== "string" || typeof reference.createdAt !== "string") throw new Error("Invalid personal API token metadata");
    return { id: reference.tokenId, agentName, userId, masked: reference.masked, createdAt: reference.createdAt };
  },
  async replace(token, previousTokenId) {
    await transact([
      { kind: "check", key: keys.agent(token.agentName), condition: agentIsLive },
      { kind: "put", item: { ...keys.agentApiTokenUser(token.agentName, token.userId), entityType: "APITOKENUSER", agentName: token.agentName, userId: token.userId, tokenId: token.id, masked: token.masked, createdAt: token.createdAt },
        condition: row => previousTokenId === null ? row === null : row?.tokenId === previousTokenId },
      { kind: "put", item: { ...keys.agentApiToken(token.agentName, token.id), entityType: "APITOKEN", ...token }, condition: row => row === null },
      ...(previousTokenId ? [{ kind: "delete" as const, key: keys.agentApiToken(token.agentName, previousTokenId), condition: (row: Item | null) => row?.userId === token.userId }] : []),
    ]);
  },
  async revoke(agentName, userId, tokenId) {
    await transact([
      { kind: "check", key: keys.agent(agentName), condition: agentIsLive },
      { kind: "delete", key: keys.agentApiTokenUser(agentName, userId), condition: row => row?.tokenId === tokenId },
      { kind: "delete", key: keys.agentApiToken(agentName, tokenId), condition: row => row?.userId === userId },
    ]);
  },
};
