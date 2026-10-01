export const MESSAGING_PLATFORMS = ["slack", "telegram", "teams"] as const;
export type MessagingPlatform = (typeof MESSAGING_PLATFORMS)[number];
export interface MessagingSubject {
  agentName: string;
  platform: MessagingPlatform;
  /** Workspace/tenant identity from the authenticated envelope; Telegram uses its global user namespace. */
  realm: string;
  externalId: string;
}
export interface MessagingIdentity extends MessagingSubject { userId: string; linkedAt: string }
export interface MessagingLinkCode { hash: string; agentName: string; platform: MessagingPlatform; userId: string; expiresAt: number }
export interface MessagingIdentityRepository {
  get(subject: MessagingSubject): Promise<MessagingIdentity | null>;
  list(userId: string, limit: number): Promise<MessagingIdentity[]>;
  issue(code: MessagingLinkCode): Promise<void>;
  code(agentName: string, hash: string, now: number): Promise<MessagingLinkCode | null>;
  /** Consume the code and bind one platform sender atomically; never replace a different user's link. */
  bind(code: MessagingLinkCode, identity: MessagingIdentity, now: number): Promise<void>;
  unlink(identity: MessagingIdentity): Promise<void>;
}
