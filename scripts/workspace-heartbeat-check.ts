import { assertWorkspaceHeartbeat } from "./workspace-heartbeat";

// Keep the liveness entrypoint independent of backend, database and model initialization.
assertWorkspaceHeartbeat()
  .then(() => { console.log("OK Workspace worker heartbeat"); })
  .catch(() => { console.error("Workspace health check failed: worker heartbeat"); process.exitCode = 1; });
