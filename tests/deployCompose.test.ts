import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootCompose = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
const localMcpCompose = readFileSync(
  new URL("../deploy/local/compose.yaml", import.meta.url),
  "utf8",
);
const localMcpDeploy = readFileSync(
  new URL("../deploy/local/scripts/deploy.sh", import.meta.url),
  "utf8",
);
const postgresInit = readFileSync(
  new URL("../deploy/postgres/init.sql", import.meta.url),
  "utf8",
);

function serviceBlock(compose: string, name: string): string {
  const marker = `  ${name}:\n`;
  const match = new RegExp(`^  ${name}:$`, "m").exec(compose);
  if (!match) {
    return "";
  }
  const start = match.index;
  const rest = compose.slice(start + marker.length);
  const next = /^  [a-z][a-z0-9-]*:/m.exec(rest);
  return marker + rest.slice(0, next?.index ?? rest.length);
}

describe("deployment configuration", () => {
  it("probes the local Brave listener without spending API quota", () => {
    const service = serviceBlock(localMcpCompose, "mcp-brave-search");
    const probe = /^\s+test:.*$/m.exec(service)?.[0] ?? "";
    expect(service).toContain("healthcheck:");
    expect(probe).toContain("require('node:net').connect(80,'127.0.0.1')");
    expect(probe).not.toMatch(/curl|wget|brave\.com|tools\/call/);
  });

  it("keeps local AWS-backed MCP services behind the aws profile", () => {
    expect(serviceBlock(localMcpCompose, "mcp-cloudwatch")).toContain("profiles: [aws]");
  });

  it("retires redundant services without provisioning or dropping their data", () => {
    for (const name of ["mcp-memory", "mcp-document", "mcp-youtube"]) {
      expect(serviceBlock(localMcpCompose, name)).toBe("");
    }
    expect(localMcpDeploy).not.toMatch(/createdb|DROP DATABASE|ecr get-login-password/);
    expect(postgresInit).not.toContain("mcp_memory");
    expect(postgresInit).not.toContain("DROP DATABASE");
  });

  it("scopes new integrations and their credentials to explicit profiles", () => {
    for (const name of ["argocd", "grafana", "kubernetes"]) {
      expect(serviceBlock(localMcpCompose, `mcp-${name}`)).toContain(`profiles: [${name}]`);
    }
    expect(serviceBlock(localMcpCompose, "mcp-brave-search")).not.toContain("env_file:");
    expect(serviceBlock(localMcpCompose, "mcp-kubernetes")).toContain("create_host_path: false");
    expect(serviceBlock(localMcpCompose, "mcp-kubernetes")).toContain('"--read-only"');
    expect(serviceBlock(localMcpCompose, "mcp-argocd")).toContain('MCP_READ_ONLY: "true"');
  });

  it("owns an independent PostgreSQL 18 and MinIO stack", () => {
    expect(rootCompose).toContain("name: agent-studio-local");
    expect(rootCompose).toContain("pgvector/pgvector:0.8.6-pg18-trixie");
    expect(rootCompose).toContain("postgres18-data:/var/lib/postgresql");
    expect(rootCompose).toContain("minio:");
    expect(rootCompose).toContain("minio-init:");
    expect(serviceBlock(rootCompose, "minio")).not.toContain("profiles:");
    expect(serviceBlock(rootCompose, "minio-init")).toContain("mc mb --ignore-existing");
    expect(rootCompose).not.toContain("pgvector/pgvector:pg17");
    expect(rootCompose).not.toContain("postgres-data:/var/lib/postgresql/data");
  });
});
