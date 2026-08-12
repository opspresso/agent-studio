/**
 * The port a managed MCP container binds, and the image name it may run.
 *
 * Shared by both provisioners because the two have to *agree*, not merely
 * behave alike. A managed server is provisioned by whichever adapter this
 * deployment selected and then reached by name at dispatch: if the Docker
 * adapter and the SSM adapter derived different ports for the same name, the
 * container would start, report healthy, and be unreachable — a failure with no
 * error anywhere. They were byte-identical copies, doc comment included, which
 * is exactly how two values that must agree begin to disagree.
 */

/** Ports handed to managed containers. Above the ephemeral range this app uses. */
const PORT_BASE = 3100;

/** `host/path:tag` or `…@sha256:…`. No spaces, quotes, or shell metacharacters. */
export const MANAGED_IMAGE = /^[A-Za-z0-9._\-/]+(?::[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})$/;

/**
 * An SSM parameter path, or a host path an env file may be read from.
 *
 * Only the SSM adapter validated its `envRefs`; the Docker adapter passed them
 * straight to `--env-file`, so the two disagreed about what a reference may be
 * for no reason either could state.
 */
export const MANAGED_ENV_REF = /^\/[A-Za-z0-9._\-/]+$/;

/** Deterministic per name, so a restart re-derives the port it already bound. */
export function managedPortFor(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return PORT_BASE + (hash % 400);
}
