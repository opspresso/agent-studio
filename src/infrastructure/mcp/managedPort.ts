/**
 * The port a managed MCP container binds, and the image name it may run.
 *
 * Its own module rather than a detail of the provisioner, because the port is
 * derived twice: once when a container is started, and again when it is
 * reached by name at dispatch or repaired after a restart. If the two
 * derivations ever differed, the container would start, report healthy, and
 * be unreachable — a failure with no error anywhere. When there were two
 * provisioners they carried byte-identical copies of this, which is exactly
 * how two values that must agree begin to disagree.
 */

/** Ports handed to managed containers. Above the ephemeral range this app uses. */
const PORT_BASE = 3100;

/** Deterministic per name, so a restart re-derives the port it already bound. */
export function managedPortFor(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return PORT_BASE + (hash % 400);
}
