/** Classify bounded Git diagnostics without exposing remote text, URLs or credentials. */
export function serverGitFailure(operation: string, code: number | null, diagnostic: string): string {
  const prefix = `Server Git ${operation} failed (exit ${code ?? "signal"})`;
  const text = diagnostic.toLowerCase();
  if (/refusing to allow .* to (create|update|create or update) workflow.*without.*workflow.*scope|workflow.*permission.*required/.test(text)) {
    return `${prefix}: the GitHub credential cannot create or update Actions workflow files. Configure the workflow scope (classic token) or Workflows write permission for the intended repositories, then inspect the remote branch before preparing a new push.`;
  }
  if (/remote branch .* not found|couldn't find remote ref/.test(text)) return `${prefix}: the base branch does not exist. Initialize the repository or select an existing branch.`;
  if (/authentication failed|could not read username|returned error: (401|403)/.test(text)) return `${prefix}: the Workspace GitHub account could not authenticate or lacks repository access.`;
  if (/repository .*not found|repository not found/.test(text)) return `${prefix}: the repository is missing or inaccessible. The allowlist does not create repositories; verify or initialize the requested repository first.`;
  if (/could not resolve host|failed to connect|connection timed out|ssl certificate problem/.test(text)) return `${prefix}: the Git endpoint could not be reached securely. Check network, DNS and certificate configuration.`;
  return prefix;
}
