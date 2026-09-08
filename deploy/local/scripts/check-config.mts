import { statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface ComposeConfig {
  services?: Record<string, {
    environment?: Record<string, unknown>;
    volumes?: Array<{ type?: string; target?: string; source?: string }>;
  }>;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Validate Compose's resolved values; never log credentials or raw config. */
export function validateConfig(config: ComposeConfig, fileExists = isFile): string[] {
  const errors = [];
  const required = {
    "mcp-cloudwatch": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    "mcp-argocd": ["ARGOCD_BASE_URL", "ARGOCD_API_TOKEN"],
    "mcp-grafana": ["GRAFANA_URL", "GRAFANA_SERVICE_ACCOUNT_TOKEN"],
    "mcp-brave-search": ["BRAVE_API_KEY"],
  };
  for (const [name, keys] of Object.entries(required)) {
    const service = config.services?.[name];
    if (!service) continue;
    for (const key of keys) {
      const value = service.environment?.[key];
      if (typeof value !== "string" || !value.trim()) {
        errors.push(`${name}: ${key} is required`);
      }
    }
  }
  const kubernetes = config.services?.["mcp-kubernetes"];
  if (kubernetes) {
    const mount = kubernetes.volumes?.find((volume) => volume.target === "/config/kubeconfig");
    if (!mount?.source || !fileExists(mount.source)) {
      errors.push("mcp-kubernetes: KUBECONFIG_PATH must name an existing file");
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateConfig(JSON.parse(readFileSync(0, "utf8")));
  if (errors.length) {
    process.stderr.write(errors.join("\n") + "\n");
    process.exitCode = 1;
  }
}
