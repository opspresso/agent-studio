/**
 * Starting and stopping the containers behind managed MCP servers.
 *
 * The port exposes workload lifecycle, independent of the Docker adapter.
 *
 * What a provisioner may be asked for is deliberately small. It takes an
 * approved image and returns the loopback address it bound — never a shell
 * command. Runtime arguments remain an argv array so adapters can pass them to
 * the container process without invoking a host shell.
 */

/** `host/path:tag` or `…@sha256:…`. No spaces, quotes, or shell metacharacters. */
export const MANAGED_IMAGE = /^[A-Za-z0-9._\-/]+(?::[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})$/;
/** An environment variable name, as env-file syntax and shells agree on it. */
export const MANAGED_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** One env-file value. A line break would create another entry. */
export const MANAGED_ENV_VALUE = /^[^\r\n]*$/;
/** One argv value. Control characters have no useful container argument meaning. */
export const MANAGED_ARG = /^[^\u0000-\u001f\u007f]+$/;
/** Endpoint below the provisioner's loopback origin. */
export const MANAGED_ENDPOINT_PATH = /^\/(?!\/)[^\s?#]*$/;

export interface ManagedWorkloadSpec {
  /** Registry entry name; also the container name, so the pair is discoverable. */
  name: string;
  /** Image reference. An artifact, not a command. */
  image: string;
  /**
   * Container listen port. The Docker adapter publishes a host-loopback mapping
   * and sets PORT plus {{PORT}} arguments to this value. If absent, it uses
   * the host port derived from the workload name as the container port too.
   */
  containerPort?: number;
  /** Plaintext values passed only from the lifecycle boundary to the runtime adapter. */
  environment?: Record<string, string>;
  /**
   * Arguments appended to the image entrypoint. Never interpreted by a host
   * shell. `{{PORT}}` is replaced with the port the adapter expects the process
   * to bind.
   */
  args?: string[];
}

export interface ManagedWorkload {
  name: string;
  /** `http://127.0.0.1:<port>` — what the entry's url is built from. */
  address: string;
  /** Whatever the runtime calls this instance; for re-discovery after a restart. */
  identity: string;
  running: boolean;
  /** Runtime-reported detail, shown in the console when something is wrong. */
  detail?: string;
}

export interface McpProvisioner {
  /**
   * Start or replace the workload and report the address it bound. Lifecycle
   * callers serialize operations by name before reaching this port; replacing
   * is what applies an updated image or repairs an unreachable container.
   */
  start(spec: ManagedWorkloadSpec): Promise<ManagedWorkload>;
  /** Stop and remove it. Absent is success — deletion has to be retryable. */
  stop(name: string): Promise<void>;
  /** What is actually running, for status and for re-discovery after a restart. */
  inspect(name: string): Promise<ManagedWorkload | null>;
}
