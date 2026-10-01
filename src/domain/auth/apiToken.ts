/** A personal credential grants invocation of one Agent; its issuer never changes with Agent ownership. */
export interface ApiToken {
  id: string;
  agentName: string;
  userId: string;
  token: string;
  masked: string;
  createdAt: string;
}

export interface ApiTokenRepository {
  get(agentName: string, tokenId: string): Promise<ApiToken | null>;
  forUser(agentName: string, userId: string): Promise<Omit<ApiToken, "token"> | null>;
  /** Rotate only this user's credential, fenced against concurrent rotation and Agent deletion. */
  replace(token: ApiToken, previousTokenId: string | null): Promise<void>;
  revoke(agentName: string, userId: string, tokenId: string): Promise<void>;
}
