/**
 * Starting and stopping the containers behind managed MCP servers.
 *
 * A port, not a runtime. The only adapter that exists runs Docker on this
 * app's own host through SSM, but nothing above this file may know that: the
 * milestone's rule is one adapter now and a contract for the rest.
 *
 * What a provisioner may be asked for is deliberately small. It takes an
 * approved image and returns the loopback address it bound — never a command,
 * never a shell string. An operator who can create a managed server must not
 * thereby be able to run arbitrary code on the host, so there is no field here
 * in which such a thing could be written.
 */

export interface ManagedWorkloadSpec {
  /** Registry entry name; also the container name, so the pair is discoverable. */
  name: string;
  /** Image reference. An artifact, not a command. */
  image: string;
  /**
   * Port the container listens on inside itself — a request, and only an
   * adapter that publishes a mapping can grant it.
   *
   * An adapter that instead puts the container in this app's network namespace
   * has no mapping to translate with: the address is literally shared, so the
   * container must bind the very port the entry's url names, and it is told so
   * through `PORT`. There, this value cannot be honoured and is ignored.
   *
   * Optional because a restart has nobody to ask: an entry created before it
   * was persisted carries none, and an adapter without a value falls back to
   * the port it binds anyway — which is what a container told `PORT=<that
   * port>` already listens on.
   */
  containerPort?: number;
  /**
   * SSM parameter names whose contents become the container's environment.
   * References, so secrets never pass through this app or its table.
   */
  envRefs?: string[];
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
   * Start the workload and report the address it bound. Idempotent by name: a
   * second call must adopt the running container rather than start a rival,
   * because two of these would race for the same port and one would die
   * holding the entry's address.
   */
  start(spec: ManagedWorkloadSpec): Promise<ManagedWorkload>;
  /** Stop and remove it. Absent is success — deletion has to be retryable. */
  stop(name: string): Promise<void>;
  /** What is actually running, for status and for re-discovery after a restart. */
  inspect(name: string): Promise<ManagedWorkload | null>;
}
