import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runTicker(firstFailure: "http" | "transport") {
  const directory = join(tmpdir(), `studio-ticker-${process.pid}-${firstFailure}`);
  mkdirSync(directory);
  const executable = (name: string, source: string) => {
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\n${source}\n`);
    chmodSync(path, 0o755);
  };
  try {
    writeFileSync(join(directory, "clock"), "1000");
    executable("date", 'if [ "$1" = +%s ]; then /bin/cat "$FIXTURE/clock"; else echo fixture-time; fi');
    executable("curl", `
      count=0
      [ ! -f "$FIXTURE/count" ] || count=$(/bin/cat "$FIXTURE/count")
      count=$((count + 1))
      echo "$count" > "$FIXTURE/count"
      for argument in "$@"; do target=$argument; done
      echo "$target" >> "$FIXTURE/requests"
      now=$(/bin/cat "$FIXTURE/clock")
      echo "$((now + 5))" > "$FIXTURE/clock"
      if [ "$count" -eq 1 ]; then
        echo ${firstFailure === "http" ? "503" : "000"}
        exit ${firstFailure === "http" ? "0" : "7"}
      fi
      echo 200
    `);
    executable("sleep", `
      echo "$1" >> "$FIXTURE/sleeps"
      now=$(/bin/cat "$FIXTURE/clock")
      echo "$((now + $1))" > "$FIXTURE/clock"
      count=$(/bin/cat "$FIXTURE/count")
      if [ "$count" -ge 5 ]; then kill -TERM "$PPID"; fi
    `);
    const result = spawnSync("/bin/sh", [join(process.cwd(), "deploy/local/scripts/tick.sh")], {
      env: { ...process.env, PATH: directory, FIXTURE: directory, TICK_TARGET: "http://fixture",
        SCHEDULE_SCAN_TOKEN: "fixture-private-token" }, encoding: "utf8", timeout: 5000,
    });
    return { result, requests: readFileSync(join(directory, "requests"), "utf8").trim().split("\n"),
      sleeps: readFileSync(join(directory, "sleeps"), "utf8").trim().split("\n") };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("resident schedule ticker", () => {
  it.each(["http", "transport"] as const)("keeps independent endpoints ticking after a %s failure without minute drift", failure => {
    const { result, requests, sleeps } = runTicker(failure);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(requests).toEqual([
      "http://fixture/api/triggers/scan", "http://fixture/api/plugins/sync/scan", "http://fixture/api/catalog/reindex",
      "http://fixture/api/triggers/scan", "http://fixture/api/plugins/sync/scan",
    ]);
    expect(sleeps).toEqual(["45", "50"]);
    expect(result.stderr).toContain(failure === "http" ? "HTTP 503 (curl exit 0)" : "HTTP 000 (curl exit 7)");
    expect(result.stderr).not.toContain("000000");
    expect(result.stdout + result.stderr).not.toContain("fixture-private-token");
  });
});
