export type AgentCredentialPurpose = "api" | "webhook";

/** A personal credential grants invocation of one Agent; its issuer never changes with Agent ownership. */
export interface AgentCredential {
  purpose: AgentCredentialPurpose;
  id: string;
  agentName: string;
  userId: string;
  token: string;
  masked: string;
  createdAt: string;
}

export interface AgentCredentialRepository {
  get(agentName: string, purpose: AgentCredentialPurpose, tokenId: string): Promise<AgentCredential | null>;
  forUser(agentName: string, purpose: AgentCredentialPurpose, userId: string): Promise<Omit<AgentCredential, "token"> | null>;
  /** Rotate only this user's credential, fenced against concurrent rotation and Agent deletion.
   * Webhook issuance atomically initializes missing shared settings without changing existing behavior. */
  replace(token: AgentCredential, previousTokenId: string | null): Promise<void>;
  revoke(agentName: string, purpose: AgentCredentialPurpose, userId: string, tokenId: string): Promise<void>;
}
