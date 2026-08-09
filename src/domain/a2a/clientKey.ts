/**
 * A named inbound-A2A credential. The shared `A2A_API_KEY` authenticates every
 * machine caller as one anonymous identity (`a2a:shared-key`); a client key
 * names its holder, so their runs are attributed and bounded per caller, and
 * one client can be revoked without rotating everyone else.
 */
export interface A2aClientKey {
  /** Slug — becomes the actor id (`a2a:{name}`) on every run the key starts. */
  name: string;
  description?: string;
  /** `enc:v1:` ciphertext of the key value, so it can be revealed later. */
  token: string;
  /** SHA-256 hex of the value — the verification row's key, kept for deletion. */
  tokenHash: string;
  /** Display mask recorded at generation, so listing costs no decryption. */
  masked: string;
  createdAt: string;
}

export interface A2aClientKeyRepository {
  get(name: string): Promise<A2aClientKey | null>;
  list(): Promise<A2aClientKey[]>;
  /** Conditional create of the key and its hash row; rejects an existing name. */
  create(key: A2aClientKey): Promise<void>;
  /** Removes the key and its hash row. False when there was no such key. */
  delete(name: string): Promise<boolean>;
  /** The client name a raw value's hash resolves to — the verification read. */
  findNameByHash(tokenHash: string): Promise<string | null>;
}
