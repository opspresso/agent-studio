/** Operator-declared identity contract; never an executable expression or a write request. */
export type McpAccountLookup =
  | { kind: "none" }
  | { kind: "http"; endpoint: string; labelPath: string; scopes?: string[] }
  | { kind: "mcp"; toolName: string; arguments: Record<string, unknown>; labelPath: string };
