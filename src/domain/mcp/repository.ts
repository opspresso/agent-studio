import type { McpServer } from "./types";

export interface McpRepository {
  get(name: string): Promise<McpServer | null>;
  list(): Promise<McpServer[]>;
  create(server: McpServer): Promise<void>;
  update(server: McpServer): Promise<void>;
  put(server: McpServer): Promise<void>;
  delete(name: string): Promise<void>;
}
