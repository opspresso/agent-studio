import type { McpServer, McpServerAuth } from "./types";

export interface McpRepository {
  get(name: string): Promise<McpServer | null>;
  list(limit: number, after?: string): Promise<McpServer[]>;
  create(server: McpServer): Promise<void>;
  update(server: McpServer): Promise<void>;
  put(server: McpServer): Promise<void>;
  /** Patch only OAuth metadata while the entry still exists at the expected URL. */
  updateAuth(name: string, expectedUrl: string, auth: McpServerAuth | undefined, updatedAt: string, expected?: { auth?: McpServerAuth }): Promise<boolean>;
  delete(name: string): Promise<void>;
}
