import type { MessagingIdentity, MessagingIdentityRepository, MessagingSubject, MessagingLinkCode } from "@/domain/messaging/identity";
import { getItem, queryItems, transact, type Item } from "../store";
import { keys } from "../keys";
import { agentIsLive } from "../agentLifecycle";

function identity(row: Item | null): MessagingIdentity | null {
  if (!row) return null;
  if (row.entityType !== "MESSAGINGIDENTITY" || typeof row.agentName !== "string" || !["slack", "telegram", "teams"].includes(String(row.platform)) ||
    typeof row.realm !== "string" || typeof row.externalId !== "string" || typeof row.userId !== "string" || typeof row.linkedAt !== "string") throw new Error("Invalid messaging identity record");
  return { agentName: row.agentName, platform: row.platform as MessagingIdentity["platform"], realm: row.realm, externalId: row.externalId, userId: row.userId, linkedAt: row.linkedAt };
}
export const messagingIdentityRepository: MessagingIdentityRepository = {
  async get(subject) {
    const record = identity(await getItem(keys.messagingIdentity(subject)));
    if (record && ["agentName", "platform", "realm", "externalId"].some(name => record[name as keyof MessagingSubject] !== subject[name as keyof MessagingSubject])) throw new Error("Messaging identity does not match its subject");
    return record;
  },
  async list(userId, limit) {
    const rows = await queryItems({ index: "GSI1", pk: keys.messagingIdentityUser(userId), limit });
    return rows.map(row => {
      const record = identity(row);
      if (!record || record.userId !== userId) throw new Error("Messaging identity user index does not match its owner");
      return record;
    });
  },
  async issue(code) {
    await transact([
      { kind: "check", key: keys.agent(code.agentName), condition: agentIsLive },
      { kind: "put", item: { ...keys.messagingLinkCode(code.agentName, code.hash), entityType: "MESSAGINGLINKCODE", ...code }, condition: row => row === null },
    ]);
  },
  async code(agentName, hash, now) {
    const row = await getItem(keys.messagingLinkCode(agentName, hash));
    if (!row || typeof row.expiresAt !== "number" || row.expiresAt <= now) return null;
    if (row.entityType !== "MESSAGINGLINKCODE" || row.hash !== hash || row.agentName !== agentName || typeof row.userId !== "string" ||
      !["slack", "telegram", "teams"].includes(String(row.platform))) throw new Error("Invalid messaging link code");
    return { hash, agentName: row.agentName, platform: row.platform as MessagingLinkCode["platform"], userId: row.userId, expiresAt: row.expiresAt };
  },
  async bind(code, record, now) {
    const key = keys.messagingIdentity(record);
    await transact([
      { kind: "check", key: keys.agent(record.agentName), condition: agentIsLive },
      { kind: "delete", key: keys.messagingLinkCode(code.agentName, code.hash), condition: row => row?.userId === record.userId && row.agentName === record.agentName && row.platform === record.platform && Number(row.expiresAt) > now },
      { kind: "put", item: { ...key, ...record, entityType: "MESSAGINGIDENTITY", GSI1PK: keys.messagingIdentityUser(record.userId), GSI1SK: key.PK + ":" + key.SK },
        condition: row => row === null || row.userId === record.userId },
    ]);
  },
  async unlink(record) {
    await transact([{ kind: "delete", key: keys.messagingIdentity(record), condition: row => row?.userId === record.userId }]);
  },
};
