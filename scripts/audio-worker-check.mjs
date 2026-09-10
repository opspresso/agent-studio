import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

// Run from the isolated standalone directory, without the repository's modules,
// secrets or services. A rejecting local socket proves the worker reached its DB
// poll; success does not claim that a real database or transcription service works.
const unavailableDatabase = createServer((socket) => socket.destroy());
await new Promise((resolve) => unavailableDatabase.listen(0, "127.0.0.1", resolve));
const { port } = unavailableDatabase.address();
const child = spawn(process.execPath, [join(process.cwd(), "build/audio-worker.cjs")], {
  env: {
    NODE_ENV: "production", STAGE: "local", MODELS_CATALOG_URL: "none",
    DATABASE_URL: `postgres://test:test@127.0.0.1:${port}/audio_worker_test`,
    S3_BUCKET_NAME: "audio-worker-check", S3_ENDPOINT: `http://127.0.0.1:${port}`,
    LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_API_KEY: "test",
    AES_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let reachedPoll = false;
const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
  output = (output + chunk).slice(-32_000);
  if (!reachedPoll && output.includes("Worker poll failed; retrying on the next poll")) {
    reachedPoll = true;
    child.kill("SIGTERM");
  }
});
try {
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve([code, signal]));
  });
  assert.ok(reachedPoll, `Audio worker did not reach polling:\n${output}`);
  assert.equal(signal, null, `Worker did not shut down gracefully:\n${output}`);
  assert.equal(code, 0, `Audio worker exited with ${code}:\n${output}`);
  console.log("Audio worker: isolated startup, failed-DB polling and SIGTERM shutdown passed");
} finally {
  clearTimeout(timeout);
  unavailableDatabase.close();
}
