/** Durable SDK data is encrypted and opaque to the storage adapter. */
export interface RuntimeSessionRow {
  sessionId: string;
  ownerEmail: string;
  projectName: string;
  revision: number;
  payload: string;
  expiresAt: string;
}

export interface RuntimeSessionRepository {
  get(sessionId: string, ownerEmail: string): Promise<RuntimeSessionRow | null>;
  /** Compare-and-swap; null means the row must not exist. */
  save(row: Omit<RuntimeSessionRow, "revision">, expectedRevision: number | null): Promise<number | null>;
  delete(sessionId: string, ownerEmail: string): Promise<void>;
  sweepExpired(now: Date): Promise<number>;
}

export interface RuntimeApproval {
  id: string;
  agent: string;
  tool: string;
  arguments: string;
}

export interface RuntimeApprovalDecision {
  id: string;
  approve: boolean;
}

export interface RuntimePolicy {
  maxInputChars?: number;
  blockedTools?: string[];
  approvalTools?: string[];
}
