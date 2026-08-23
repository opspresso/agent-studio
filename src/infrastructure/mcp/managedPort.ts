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

/** `host/path:tag` or `…@sha256:…`. No spaces, quotes, or shell metacharacters. */
export const MANAGED_IMAGE = /^[A-Za-z0-9._\-/]+(?::[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})$/;

/**
 * A host path an env file is read from (`--env-file`). Absolute, and nothing
 * a shell or the Docker CLI would read as anything but a path — the values
 * an operator types are the one input here that reaches a command line.
 */
export const MANAGED_ENV_REF = /^\/[A-Za-z0-9._\-/]+$/;
/** An environment variable's name, as the env-file format and a shell agree on one. */
export const MANAGED_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Deterministic per name, so a restart re-derives the port it already bound. */
export function managedPortFor(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return PORT_BASE + (hash % 400);
}
