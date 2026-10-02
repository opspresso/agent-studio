import { createHmac, hkdfSync } from "node:crypto";
import type { WorkspaceModelClaims, WorkspaceModelTokens } from "@/domain/workspace/modelGateway";
import { timingSafeEqualString } from "@/shared/timingSafe";

/** Domain-separated from object URLs, sessions and stored credential encryption. */
export function createWorkspaceModelTokens(masterKey: Uint8Array): WorkspaceModelTokens {
  const key = Buffer.from(hkdfSync("sha256", masterKey, "", "agent-studio/workspace-model/v1", 32));
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");
  return {
    issue: claims => { const payload = Buffer.from(JSON.stringify(claims)).toString("base64url"); return payload + "." + sign(payload); },
    verify(token, nowSeconds) {
      if (!token || token.length > 4096) return null;
      const parts = token.split(".");
      if (parts.length !== 2 || !timingSafeEqualString(parts[1]!, sign(parts[0]!))) return null;
      try {
        const value: unknown = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
        if (!value || typeof value !== "object") return null;
        const c = value as WorkspaceModelClaims;
        return typeof c.workspaceId === "string" && !!c.workspaceId && typeof c.runId === "string" && !!c.runId &&
          typeof c.model === "string" && !!c.model && ["codex", "claude", "opencode"].includes(c.runtime) &&
          Number.isSafeInteger(c.expiresAt) && c.expiresAt > nowSeconds ? c : null;
      } catch { return null; }
    },
  };
}
