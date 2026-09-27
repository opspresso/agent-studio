/**
 * Derive the same host port for provisioning, inspection and restart.
 * Collisions are possible within the 400-port range and are reported by the
 * provisioner; this function does not reserve a port.
 */

/** Start of the managed host-port range. */
const PORT_BASE = 3100;

/** Deterministic per name, so a restart re-derives the port it already bound. */
export function managedPortFor(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return PORT_BASE + (hash % 400);
}
