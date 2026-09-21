import type { McpBinding } from "@/domain/project/types";
import type { McpRepository } from "@/domain/mcp/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { ValidationError } from "@/application/errors";
import { hasMcpHeaderSecrets, mcpHeaderTarget } from "@/application/mcpHeaderTarget";

/**
 * Resolve submitted MCP bindings to their stored form: header override values
 * are encrypted at rest, and a masked or empty value keeps the secret already
 * stored under the same server, header name, and endpoint fingerprint. A move
 * drops preserved values; only credentials freshly entered for the current URL
 * survive. A binding with no overrides is stored without either secret field.
 */
export async function resolveMcpBindings(
  cipher: SecretCipher,
  mcps: Pick<McpRepository, "get">,
  next: McpBinding[],
  existing: McpBinding[],
  context: (serverName: string) => string,
  storedContext: (serverName: string) => string = context,
): Promise<McpBinding[]> {
  const storedByName = new Map(existing.map((binding) => [binding.name, binding]));
  return Promise.all(
    next.map(async (binding) => {
      // Carry the binding forward and replace only the internal credential
      // fields. Rebuilding it from `{ name, headers }` is what silently dropped
      // `tools`; the submitted target is ignored because only the server can
      // bind a newly entered secret to the current registry URL.
      const { headers: inputHeaders, headerTarget: _untrustedTarget, ...rest } = binding;
      const stored = storedByName.get(binding.name);
      // Editing a tool selection or model must not erase its endpoint configuration.
      // An explicit empty map clears overrides; an omitted map preserves them.
      const submitted = inputHeaders ?? (stored?.headers
        ? cipher.maskHeaderOverrides(stored.headers, storedContext(binding.name))
        : undefined);
      if (!submitted || Object.keys(submitted).length === 0) {
        return rest;
      }
      const current = await mcps.get(binding.name);
      const hasNewSecret = Object.values(submitted).some(
        (value) => typeof value === "string" && value !== "" && !cipher.isMasked(value),
      );
      if (!current && hasNewSecret) {
        throw new ValidationError(
          `MCP server "${binding.name}" does not exist; its header credentials cannot be bound to an endpoint.`,
        );
      }
      const currentTarget = current ? mcpHeaderTarget(current.url) : undefined;
      const storedHeaders =
        !current || stored?.headerTarget === currentTarget ? stored?.headers ?? {} : {};
      const headers = cipher.mergeHeaderOverrideUpdate(
        storedHeaders,
        submitted,
        context(binding.name),
        storedContext(binding.name),
      );
      if (Object.keys(headers).length === 0) {
        return rest;
      }
      const headerTarget = hasMcpHeaderSecrets(headers)
        ? currentTarget ?? stored?.headerTarget
        : undefined;
      return { ...rest, headers, ...(headerTarget ? { headerTarget } : {}) };
    }),
  );
}
