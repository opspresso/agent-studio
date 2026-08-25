import { createHash } from "node:crypto";
import type { HeaderOverrides } from "@/domain/security/secretCipher";

/** Bind version-owned MCP credentials to the exact registry URL they were saved for. */
export function mcpHeaderTarget(url: string): string {
  return createHash("sha256").update(url).digest("base64url");
}

/** `null` only removes a registry default; string values are credentials that need a target. */
export function hasMcpHeaderSecrets(headers: HeaderOverrides | undefined): boolean {
  return Object.values(headers ?? {}).some((value) => typeof value === "string");
}
