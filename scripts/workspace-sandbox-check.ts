import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { createWorkspaceRuntimeAdapter, withWorkspaceModelChannel } from "@/infrastructure/workspace/runtimeAdapters";
import { createDockerSandboxBackend } from "@/infrastructure/workspace/dockerProvider";
import type { SandboxProvider } from "@/domain/workspace/ports";
import type { Workspace } from "@/domain/workspace/types";

/** Exercise compilers and package managers through the real, unprivileged command boundary. */
async function checkToolchains(provider: SandboxProvider, id: string) {
  const fixtures = [
    { name: "Java", timeoutMs: 120_000, marker: "java-ok", script: `
mkdir -p toolchains/java/src/main/java
cd toolchains/java
cat > src/main/java/Main.java <<'JAVA'
public class Main { public static void main(String[] args) { System.out.println("java-ok"); } }
JAVA
javac -d . src/main/java/Main.java
jar --create --file hello.jar Main.class
java -cp hello.jar Main
cat > pom.xml <<'XML'
<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>example.test</groupId><artifactId>smoke</artifactId><version>1</version><packaging>pom</packaging></project>
XML
mvn --batch-mode --offline validate
printf "rootProject.name = 'smoke'\\n" > settings.gradle
printf "plugins { id 'java' }\\n" > build.gradle
gradle --offline --no-daemon '-Dorg.gradle.jvmargs=-Xmx256m -XX:MaxMetaspaceSize=192m' build
java -cp build/classes/java/main Main
` },
    { name: "Python", timeoutMs: 60_000, marker: "python-ok", script: `
mkdir -p toolchains/python
cd toolchains/python
cat > pyproject.toml <<'TOML'
[build-system]
requires = ["setuptools", "wheel"]
build-backend = "setuptools.build_meta"
[project]
name = "workspace-smoke"
version = "1.0.0"
[tool.setuptools]
py-modules = ["hello"]
TOML
printf 'def greet():\\n    return "python-ok"\\n' > hello.py
printf 'from hello import greet\\n\\n\\ndef test_greet():\\n    assert greet() == "python-ok"\\n' > test_hello.py
python --version
pip --version
python3 -c 'import bz2, ctypes, dbm.gnu, lzma, readline, sqlite3, ssl; from compression import zstd; assert zstd.decompress(zstd.compress(b"python-ok")) == b"python-ok"'
cat > native.c <<'C'
#include <Python.h>
static PyObject *answer(PyObject *self, PyObject *args) { return PyLong_FromLong(42); }
static PyMethodDef methods[] = { {"answer", answer, METH_NOARGS, NULL}, {NULL, NULL, 0, NULL} };
static struct PyModuleDef module = { PyModuleDef_HEAD_INIT, "native", NULL, -1, methods };
PyMODINIT_FUNC PyInit_native(void) { return PyModule_Create(&module); }
C
cc -shared -fPIC $(python3-config --includes) native.c -o native$(python3-config --extension-suffix)
python3 -c 'import native; assert native.answer() == 42'
pyproject-build --no-isolation --wheel --outdir dist
python3 -m venv --copies /tmp/python-venv
/tmp/python-venv/bin/pip install --no-index dist/*.whl
/tmp/python-venv/bin/python -I -c 'from hello import greet; print(greet())'
uv venv --offline --no-managed-python --python python3 /tmp/uv-venv
uv pip install --offline --python /tmp/uv-venv/bin/python dist/*.whl
/tmp/uv-venv/bin/python -I -c 'from hello import greet; print(greet())'
uvx --version
poetry check
pytest -q
ruff check hello.py test_hello.py
` },
    { name: "Go", timeoutMs: 180_000, marker: "go-ok 42", script: `
mkdir -p toolchains/go
cd toolchains/go
go mod init example.test/workspace-smoke
cat > main.go <<'GO'
package main
/* int answer(void) { return 42; } */
import "C"
import "fmt"
func answer() int { return int(C.answer()) }
func main() { fmt.Println("go-ok", answer()) }
GO
cat > main_test.go <<'GO'
package main
import "testing"
func TestAnswer(t *testing.T) { if answer() != 42 { t.Fatal("unexpected native result") } }
GO
gofmt -w main.go main_test.go
go vet ./...
go test ./...
go build -o hello .
./hello
` },
    { name: "Node.js", timeoutMs: 60_000, marker: "node-ok", script: `
mkdir -p toolchains/node/lib toolchains/node/pnpm toolchains/node/npm
cd toolchains/node
printf '{"name":"smoke-lib","version":"1.0.0","main":"index.js"}\\n' > lib/package.json
printf 'exports.value = 42;\\n' > lib/index.js
for manager in npm pnpm; do
  printf '{"name":"smoke-app","version":"1.0.0","scripts":{"test":"node --test test.js"},"dependencies":{"smoke-lib":"file:../lib"}}\\n' > "$manager/package.json"
  printf 'require("node:test")("local dependency", () => require("node:assert/strict").equal(require("smoke-lib").value, 42));\\n' > "$manager/test.js"
done
corepack --version
corepack pnpm --version
corepack pnpm@11.24.0 --version
cd pnpm
pnpm install --offline --ignore-scripts
pnpm test
cd ../npm
npm install --offline --ignore-scripts --no-audit --no-fund
npm test
printf 'const value: string = "node-ok"; console.log(value);\\n' > main.ts
tsc --strict --target es2022 --module commonjs --outDir dist main.ts
node dist/main.js
tsx main.ts
` },
  ];
  for (const fixture of fixtures) {
    const result = await provider.execute(id, { argv: ["/bin/sh", "-eu", "-s"], stdin: fixture.script, timeoutMs: fixture.timeoutMs });
    assert.equal(result.exitCode, 0, `${fixture.name} must build and test offline as uid 1000: ${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes(fixture.marker), `${fixture.name} must execute its compiled/installed output`);
  }
  console.log("[ok] Workspace toolchains: Java/Maven/Gradle, Python/pip/uv/Poetry/pytest/ruff, Go/cgo, Node/npm/Corepack/pnpm/TypeScript");
}

/** Disposable, network-isolated containers; never uses host credentials or a host volume. */
async function main() {
  const { provider, control } = createDockerSandboxBackend({ image: process.env.WORKSPACE_SANDBOX_IMAGE || "agent-studio-workspace:test",
    network: "none", memoryMb: 1024, diskMb: 1024, cpus: 2 });
  const workspaceId = `smoke-${randomUUID()}`;
  const containers = new Set<string>();
  const run = (id: string, script: string) => provider.execute(id, { argv: ["/bin/sh", "-s"], stdin: script, timeoutMs: 10_000 });
  try {
    const { externalId: id } = await provider.ensure(workspaceId);
    containers.add(id);
    assert.equal((await provider.ensure(workspaceId)).externalId, id, "ensure reuses the same container");
    assert.equal(await provider.inspect(id), "ready");
    if (process.env.WORKSPACE_TEST_AGENTS === "true") {
      for (const executable of ["codex", "claude", "opencode"] as const) {
        const version = await provider.execute(id, { argv: [executable, "--version"], timeoutMs: 10_000 });
        assert.equal(version.exitCode, 0, `${executable} must execute as a non-root sandbox user: ${version.stderr}`);
        assert.match(version.stdout, /\d+\.\d+/);
        const workspace: Workspace = { id: workspaceId, chatId: "toolchain-check", ownerEmail: "member@example.test",
          agentName: "toolchain-check", title: "CLI compatibility", runtime: executable, sessionId: randomUUID(), revision: 0,
          status: "active", createdAt: "", updatedAt: "", dueAt: "", idleTtlSeconds: 60 };
        for (const nativeSessionId of [undefined, workspace.sessionId]) {
          const command = createWorkspaceRuntimeAdapter(executable, { model: "fixture-model" }).command(workspace,
            { id: workspace.sessionId, workspaceId, runtime: executable, nativeSessionId, createdAt: "", updatedAt: "" },
            { kind: "task", prompt: "fixture" }, 10_000);
          const separator = command.argv.indexOf("--");
          command.argv.splice(separator < 0 ? command.argv.length : separator, 0, "--help");
          const help = await provider.execute(id, command);
          assert.equal(help.exitCode, 0, `${executable} must accept the adapter's start/resume flags: ${help.stdout}\n${help.stderr}`);
        }
      }
    }
    await checkToolchains(provider, id);
    const runtime = withWorkspaceModelChannel("opencode", { model: "provider/test-model" }, { name: "selfhosted", baseUrl: "http://127.0.0.1:19090/v1", apiKey: "test-only-key" });
    const admission = await provider.execute(id, { argv: ["node", "-e", 'console.log(JSON.stringify({ disabled: process.env.OPENCODE_DISABLE_MODELS_FETCH, sdk: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).provider["studio-workspace"].npm }))'],
      environment: runtime.environment, timeoutMs: 10_000 });
    assert.equal(admission.exitCode, 0, "runtime channel environment must pass the actual Sandbox command boundary");
    assert.deepEqual(JSON.parse(admission.stdout), { disabled: "true", sdk: "@ai-sdk/openai-compatible" });
    await assert.rejects(provider.execute(id, { argv: ["true"], environment: { GITHUB_TOKEN: "test-only-key" }, timeoutMs: 10_000 }), /Unsupported runtime environment/);
    assert.equal((await run(id, "id -u")).stdout.trim(), "1000");
    assert.equal((await run(id, 'test -d "$CODEX_HOME" && test -w "$CODEX_HOME"')).exitCode, 0, "native runtime home exists before the first task");
    assert.equal((await run(id, "printf '#!/bin/sh\\nprintf executable' > executable.sh; chmod +x executable.sh; ./executable.sh")).stdout, "executable", "workspace package binaries must execute");
    assert.notEqual((await run(id, "touch /opt/cannot-write")).exitCode, 0);
    assert.notEqual((await run(id, "ls /control/operations")).exitCode, 0);
    assert.equal((await run(id, "test ! -e /var/run/docker.sock && test -z \"$DATABASE_URL$AWS_SECRET_ACCESS_KEY$GITHUB_TOKEN\" && echo isolated")).stdout.trim(), "isolated");
    assert.equal((await run(id, "printf first > state.txt; mkdir -p \"$HOME/.codex/sessions\"; printf native > \"$HOME/.codex/sessions/session.jsonl\"; printf excluded > \"$HOME/.codex/auth.json\"; ln -s state.txt state-link")).exitCode, 0);
    assert.equal((await run(id, "printf second >> state.txt; cat state.txt")).stdout, "firstsecond");
    await assert.rejects(control(id, "git-prepare", { branch: "agent/preserve-files", baseBranch: "main", url: "https://example.com/repo.git" }), /workdir is not empty/);
    assert.equal((await run(id, "cat state.txt")).stdout, "firstsecond", "repository attachment must not overwrite task files");
    assert.equal((await run(id, "printf private > locked.txt; chmod 000 locked.txt")).exitCode, 0);
    assert.equal((await run(id, 'mkdir -p "$HOME/.codex/.tmp" "$HOME/.npm"; truncate -s 70000000 "$HOME/.npm/cache"; ln -s /usr/bin/node "$HOME/.codex/.tmp/alias"')).exitCode, 0);
    assert.equal((await run(id, `
set -eu
for cache in .m2/repository .gradle/caches .gradle/daemon .gradle/wrapper/dists go/pkg/mod .local/share/pnpm/store; do
  mkdir -p "$HOME/$cache"
  truncate -s 70000000 "$HOME/$cache/excluded"
done
printf '<settings/>\\n' > "$HOME/.m2/settings.xml"
printf 'org.gradle.daemon=false\\n' > "$HOME/.gradle/gradle.properties"
`)).exitCode, 0);

    const operationId = "stable-operation";
    const command = { argv: ["/bin/sh", "-s"], stdin: "printf once >> state.txt; echo streamed; sleep 1; echo ended", timeoutMs: 10_000 };
    await provider.start(id, operationId, command);
    await provider.start(id, operationId, command);
    let state = await provider.operation(id, operationId);
    const deadline = Date.now() + 15_000;
    while ((state.status === "running" || state.status === "starting") && Date.now() < deadline) {
      await delay(100);
      state = await provider.operation(id, operationId);
    }
    assert.equal(state.status, "succeeded");
    const output = await provider.output(id, operationId, 0);
    assert.match(output.frames.map(frame => frame.text).join(""), /streamed/);
    assert.match(output.frames.map(frame => frame.text).join(""), /ended/);
    assert.deepEqual((await provider.output(id, operationId, output.nextOffset)).frames, []);
    assert.equal((await run(id, "cat state.txt")).stdout, "firstsecondonce", "duplicate start never executes twice");
    await provider.start(id, "unicode-operation", { argv: ["node", "-e", "process.stdout.write('x'.repeat(1999) + '😀')"], timeoutMs: 10_000 });
    for (let attempt = 0; attempt < 30 && (await provider.operation(id, "unicode-operation")).status !== "succeeded"; attempt++) await delay(100);
    const unicode = await provider.output(id, "unicode-operation", 0);
    for (const frame of unicode.frames) {
      assert.equal(Buffer.from(frame.text, "utf8").toString("utf8"), frame.text, "every persisted frame contains complete Unicode characters");
    }

    await provider.start(id, "next-operation", { argv: ["/bin/sh", "-s"], stdin: "sleep 1; echo next", timeoutMs: 10_000 });
    await provider.cancel(id, operationId);
    for (let attempt = 0; attempt < 30 && !["succeeded", "failed"].includes((await provider.operation(id, "next-operation")).status); attempt++) await delay(100);
    assert.equal((await provider.operation(id, "next-operation")).status, "succeeded", "late cancellation cannot stop the next operation");

    await provider.start(id, "cancel-operation", { argv: ["/bin/sh", "-s"], stdin: "sleep 60", timeoutMs: 70_000 });
    for (let attempt = 0; attempt < 30 && (await provider.operation(id, "cancel-operation")).status !== "running"; attempt++) await delay(100);
    await provider.cancel(id, "cancel-operation");
    for (let attempt = 0; attempt < 30 && (await provider.operation(id, "cancel-operation")).status === "running"; attempt++) await delay(100);
    assert.equal((await provider.operation(id, "cancel-operation")).status, "failed");

    const checkpoint = await provider.checkpoint(id);
    await provider.destroy(id);
    assert.equal(await provider.inspect(id), "missing");
    await provider.destroy(id);
    const { externalId: restored } = await provider.ensure(workspaceId);
    containers.add(restored);
    assert.notEqual(restored, id, "recreated compute has a new immutable handle");
    await provider.restore(restored, checkpoint);
    assert.equal((await run(restored, "cat state-link; cat \"$HOME/.codex/sessions/session.jsonl\"")).stdout, "firstsecondoncenative");
    assert.equal((await run(restored, "test ! -e \"$HOME/.codex/auth.json\" && echo excluded")).stdout.trim(), "excluded");
    assert.equal((await run(restored, "stat -c %a locked.txt")).stdout.trim(), "0", "file permissions survive restoration");
    assert.equal((await run(restored, 'test ! -e "$HOME/.npm/cache" && test ! -e "$HOME/.codex/.tmp/alias"')).exitCode, 0, "regenerable native and package caches do not enter checkpoints");
    assert.equal((await run(restored, `
set -eu
for cache in .m2/repository .gradle/caches .gradle/daemon .gradle/wrapper/dists go/pkg/mod .local/share/pnpm/store; do
  test ! -e "$HOME/$cache/excluded"
done
test -f "$HOME/.m2/settings.xml"
test -f "$HOME/.gradle/gradle.properties"
corepack pnpm --version
`)).exitCode, 0, "language caches are excluded, user configuration persists, and Corepack is reseeded offline after restore");
    await assert.rejects(provider.restore(restored, checkpoint), /empty sandbox/);

    const { externalId: empty } = await provider.ensure(`invalid-${randomUUID()}`);
    containers.add(empty);
    const attack = gzipSync(JSON.stringify([{ path: "repo/../../control/evil", kind: "file", content: "eA==" }]));
    await assert.rejects(provider.restore(empty, attack), /checkpoint path/);
    const linkAttack = gzipSync(JSON.stringify([{ path: "repo/link", kind: "link", target: "/control" }]));
    await assert.rejects(provider.restore(empty, linkAttack), /checkpoint link/);
    console.log("[ok] Docker sandbox: isolation, file continuity, exact operation identity, output replay, cancel, checkpoint and restore");
  } finally {
    for (const id of containers) await provider.destroy(id);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
