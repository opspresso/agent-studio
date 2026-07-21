import type { ExternalAgent } from "./types";

export interface ExternalAgentRepository {
  get(name: string): Promise<ExternalAgent | null>;
  list(): Promise<ExternalAgent[]>;
  put(agent: ExternalAgent): Promise<void>;
  delete(name: string): Promise<void>;
}
