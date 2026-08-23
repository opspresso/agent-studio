/**
 * Naming a host the deployment declared reachable, on a network the SSRF guard
 * cannot vouch for.
 *
 * One predicate, two lists. The MCP registry and the `FetchUrl` builtin each
 * carry their own suffix list, widened only by a deploy and never by a console
 * form, and they are deliberately *different* lists: a cluster MCP service the
 * app is meant to call is not thereby a page a model may be talked into
 * reading. What they share is how a name is matched, which is this file.
 */

/** An IPv4 literal, an IPv6 literal, or `[…]` as a URL renders one. */
function isIpLiteral(hostname: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":") || hostname.startsWith("[")
  );
}

/**
 * A host an operator declared reachable, on a network the guard cannot vouch
 * for — a Kubernetes Service name, whose address is private by construction.
 *
 * The suffix list comes from deployment configuration and nowhere else. Letting
 * a registry entry name its own exemption would hand back exactly what the SSRF
 * guard exists to take away: the ability for a typed URL to reach an internal
 * service. Changing this list should take a deploy, which is why it is not among
 * the settings the console can edit.
 *
 * Matching is anchored on a label boundary, so `agent-mcps.svc.cluster.local`
 * admits `mcp-url-fetch.agent-mcps.svc.cluster.local` and never
 * `evil-agent-mcps.svc.cluster.local`. A leading dot is accepted and ignored, so
 * both spellings of a suffix mean the same thing.
 *
 * Two things it will not do. A single-label suffix (`local`, `internal`) is
 * refused, because one of those admits a whole namespace of names and is far
 * more likely a mistake than an intent. And an IP literal never matches: the
 * point is a name someone chose to publish, and an address has no name to
 * match — a private address still has to earn its way through provenance.
 */
export function isDeclaredInternalHost(url: string, suffixes: readonly string[]): boolean {
  if (suffixes.length === 0) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  // A trailing dot is the same name in fully-qualified form.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || isIpLiteral(host)) {
    return false;
  }
  return suffixes.some((raw) => {
    const suffix = raw.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    if (suffix === "" || !suffix.includes(".")) {
      return false;
    }
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}
