import type { CodingWorktree } from "@/domain/coding/worktree";
import { isGitBranch, isRepositoryName } from "@/domain/workspace/policy";
import { isDeclaredInternalHost } from "@/domain/security/internalHosts";
import { resolvePublicUrl } from "@/infrastructure/net/ssrfGuard";
import { createDockerSandboxBackend, type DockerSandboxConfig } from "./dockerProvider";
import { createGitBundleTransport } from "./gitBundleTransport";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";

export interface GitWorktreeConfig {
  webUrl: string;
  internalHosts: string[];
  /** A server-side broker issues a repository-scoped installation token, never a PAT. */
  credential?: (repository: string, access: "read" | "write") => Promise<{ token: string; expiresAt: string }>;
  serverToken?: () => Promise<string>;
}

export function createDockerCodingWorktree(sandbox: DockerSandboxConfig, config: GitWorktreeConfig): CodingWorktree {
  const { control } = createDockerSandboxBackend(sandbox);
  const transport = config.serverToken ? createGitBundleTransport(config.serverToken) : undefined;
  async function network(repository: string, access: "read" | "write", expectedUrl?: string) {
    if (!isRepositoryName(repository)) throw new Error("Invalid coding repository");
    const url = new URL(`${config.webUrl.replace(/\/+$/, "")}/${repository}.git`);
    if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid Git web URL");
    if (url.protocol !== "https:" && !isDeclaredInternalHost(url.href, config.internalHosts)) throw new Error("Public Git endpoints require HTTPS");
    if (expectedUrl && url.href !== expectedUrl) throw new Error("Workspace repository origin changed");
    let resolve: string | undefined;
    if (!isDeclaredInternalHost(url.href, config.internalHosts)) {
      const resolved = await resolvePublicUrl(url.href);
      const ip = resolved.addresses[0];
      if (!ip) throw new Error("Git host did not resolve");
      resolve = `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}:${ip.includes(":") ? `[${ip}]` : ip}`;
    }
    if (!transport && !config.credential) throw new Error("Workspace Git credentials are not configured");
    const credential = transport ? {} : await config.credential!(repository, access);
    return { url: url.href, ...credential, ...(resolve ? { resolve } : {}) };
  }
  return {
    async prepare(externalId, repository) {
      if (!isGitBranch(repository.baseBranch) || !isGitBranch(repository.branch) || !repository.branch.startsWith("agent/")) throw new Error("Invalid workspace Git branch");
      const expectedUrl = `${config.webUrl.replace(/\/+$/, "")}/${repository.repository}.git`;
      if (repository.remoteUrl && repository.remoteUrl !== expectedUrl) throw new Error("Workspace repository origin changed");
      const remote = repository.baseSha ? { url: expectedUrl } : await network(repository.repository, "read", repository.remoteUrl);
      const bundle = transport && !repository.baseSha ? await transport.download(remote, repository.baseBranch) : undefined;
      const result = await control<{ baseSha: string; headSha: string }>(externalId, "git-prepare", { ...remote, ...repository, ...(bundle ? { bundle } : {}), existingOnly: !!repository.baseSha });
      if (repository.baseSha && repository.baseSha !== result.baseSha) throw new Error("Workspace Git base changed");
      return { ...repository, ...result, remoteUrl: remote.url };
    },
    review: externalId => control(externalId, "git-review", {}),
    async commit(externalId, input) { return (await control<{ sha: string }>(externalId, "git-commit", input)).sha; },
    async push(externalId, repository) {
      const remote = await network(repository.repository, "write", repository.remoteUrl);
      if (transport) {
        const { bundle } = await control<{ bundle: string }>(externalId, "git-bundle", { ...remote, ...repository }, Math.ceil(WORKSPACE_LIMITS.checkpointBytes * 4 / 3) + 1000);
        await transport.upload(remote, repository.branch, repository.headSha!, bundle);
      } else await control(externalId, "git-push", { ...remote, ...repository });
    },
  };
}
