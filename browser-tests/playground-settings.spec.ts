import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import postcss, { type AcceptedPlugin } from "postcss";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;
let toolRequests: unknown[];
let connectionRequests: string[];
let configurationWrites: Record<string, unknown>[];
let connected: boolean;
let runRequests: Record<string, unknown>[];
let evaluationRequests: Record<string, unknown>[];
let omitReceipt: boolean;
let runError: boolean;
let failEvaluation: boolean;
const prefix = "/api/agents/fixture-agent";
const serverName = "personal-tools";

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["browser-tests/fixtures/playground-settings.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-playground-settings-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "next-navigation", setup(build) {
      build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "next-stub" }));
      build.onLoad({ filter: /.*/, namespace: "next-stub" }, () => ({
        contents: 'export const useParams = () => ({ name: "fixture-agent" }); export const usePathname = () => location.pathname;', loader: "js",
      }));
    } }],
  });
  // Use the application's breakpoint variables, which esbuild alone does not expand.
  const cssConfig = (await import(pathToFileURL(resolve("postcss.config.mjs")).href)).default as { plugins: Record<string, object> };
  const plugins = await Promise.all(Object.entries(cssConfig.plugins).map(async ([name, options]) => {
    const createPlugin = (await import(name)).default as (options: object) => AcceptedPlugin;
    return createPlugin(options);
  }));
  for (const file of bundle.outputFiles.filter(file => file.path.endsWith(".css"))) {
    file.contents = new TextEncoder().encode((await postcss(plugins).process(file.text, { from: undefined })).css);
  }
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/playground-settings.css"><div id="root"></div><script src="/playground-settings.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => {
  toolRequests = []; connectionRequests = []; configurationWrites = []; connected = true;
  runRequests = []; evaluationRequests = []; omitReceipt = false; runError = false; failEvaluation = false;
  page.on("pageerror", error => { throw error; });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === `${prefix}/agent`) {
      runRequests.push(route.request().postDataJSON());
      const chunks = [runError ? { error: "Synthetic execution failure" } : { delta: { content: "A report with verified sources" } }, { done: true },
        ...(!omitReceipt ? [{ evaluation: { token: `receipt-${runRequests.length}`, expiresAt: "2099-01-01T00:00:00Z" } }] : [])];
      return route.fulfill({ contentType: "text/event-stream", body: chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
    }
    if (path === `${prefix}/evaluate`) {
      evaluationRequests.push(route.request().postDataJSON());
      if (failEvaluation) return route.fulfill({ status: 502, json: { error: "Evaluation provider unavailable" } });
      return route.fulfill({ json: { summary: "The requested report is supported by the run.", model: "fixture-model", evaluatedAt: "2026-10-07T00:00:00Z",
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.003 },
        checks: Object.fromEntries(["capabilities", "output", "toolUsage", "prompt"].map(key => [key, {
          status: "pass", summary: `${key} matches the request`, evidence: ["Search call lookup-1 returned the cited sources"], improvements: [],
        }])),
        observations: [{ kind: "tool", name: "aws-knowledge", available: "offered", requests: 0 }],
        evidence: { capabilities: { toolCalls: 0, toolResults: 0, snapshots: [], inventoryComplete: true, activityComplete: true, modelRequests: 1, calls: [], skillCalls: [] }, request: "Create a report", savedBindings: "fixture-model", modelRequests: ['{"instructions":"Shared prompt"}'], toolTraffic: [], output: "A report with verified sources", artifacts: [], warnings: [], limitations: [] },
      } });
    }
    if (path === prefix) return route.fulfill({ json: { name: "fixture-agent", ownerEmail: "owner@example.test" } });
    if (path === `${prefix}/configuration`) {
      if (method === "PUT") configurationWrites.push(route.request().postDataJSON());
      return route.fulfill({ json: { updatedAt: "2026-10-02T00:00:00Z", configuration: {
        agentName: "fixture-agent", model: "fixture-model", systemPrompt: "Shared prompt", parameters: { piiFiltering: false },
        mcpList: [{ name: serverName, headers: { "X-Shared": "••••" }, tools: ["lookup"] }], skillList: [], subagentList: [],
        ...configurationWrites.at(-1),
      } } });
    }
    if (path === "/api/models") return route.fulfill({ json: { models: [] } });
    if (["/api/mcps", "/api/skills", "/api/agents"].includes(path)) return route.fulfill({ json: [] });
    if (path === `/api/mcps/${serverName}`) return route.fulfill({ json: {
      name: serverName, url: "https://mcp.example.test", headers: {},
      auth: { resource: "https://mcp.example.test", clientId: "fixture-client" },
    } });
    if (path === `${prefix}/mcp-connections/${serverName}/tools`) {
      toolRequests.push(route.request().postDataJSON());
      return route.fulfill({ json: { tools: [{ name: "lookup", description: "Read personal data" }] } });
    }
    if (path.startsWith(`${prefix}/mcp-connections`)) {
      connectionRequests.push(method);
      if (method === "DELETE") { connected = false; return route.fulfill({ status: 204 }); }
      if (method === "POST") return route.fulfill({ json: { authorizeUrl: "about:blank#fixture-authorization" } });
      return route.fulfill({ json: { connections: connected ? [{ serverName, status: "connected", scopes: [],
        connectedAccount: { label: "my-account" } }] : [] } });
    }
    return route.abort();
  });
});

for (const role of ["member", "admin"]) {
  test(`${role} opens another owner's MCP settings and manages only personal connections`, async ({ page }, testInfo) => {
    await page.goto(`${base}?role=${role}`);
    await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toBeDisabled();
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    await expect(settings).toBeEnabled();
    await settings.click();
    const dialog = page.getByRole("dialog", { name: "personal-tools settings" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /lookup/ })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "+ Add header override", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Add file mapping", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Refresh tools", exact: true }).click();
    await expect.poll(() => toolRequests.length).toBe(2);
    expect(toolRequests).toEqual([{}, {}]);
    await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
    await expect.poll(() => toolRequests.length).toBe(3);
    const popupPromise = page.waitForEvent("popup");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    const popup = await popupPromise;
    await expect.poll(() => connectionRequests.includes("POST")).toBe(true);
    await popup.close();
    expect(connectionRequests).toContain("DELETE");
    expect(configurationWrites).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${role}-mcp-settings.png`) });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toHaveValue("Shared prompt");
  });
}

test("structured output exposes a named schema editor and retains its draft across toggles", async ({ page }) => {
  await page.goto(`${base}?role=owner`);
  const enable = page.getByRole("checkbox", { name: "Structured output (JSON schema)", exact: true });
  await enable.check();
  const schema = page.getByRole("textbox", { name: "JSON schema", exact: true });
  await schema.fill('{"type":"object"}');
  await enable.uncheck();
  await expect(schema).toHaveCount(0);
  await enable.check();
  await expect(schema).toHaveValue('{"type":"object"}');
});

test("guest can inspect MCP settings without personal connection reads or tool execution", async ({ page }) => {
  await page.goto(`${base}?role=guest`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "+ Add header override", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Add file mapping", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /^(Connect|Disconnect|Refresh tools|Save)$/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  expect(toolRequests).toEqual([]);
  expect(connectionRequests).toEqual([]);
  expect(configurationWrites).toEqual([]);
});

test("owner can edit and save binding tools and probe draft headers", async ({ page }) => {
  await page.goto(`${base}?role=owner`);
  await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "+ Add header override", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Add file mapping", exact: true })).toBeEnabled();
  await dialog.getByRole("checkbox", { name: /lookup/ }).uncheck();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => configurationWrites.length).toBe(1);
  expect(configurationWrites[0]?.mcpList).toEqual([{ name: serverName, headers: { "X-Shared": "••••" } }]);
  expect(toolRequests).toEqual([{ headerOverrides: { "X-Shared": "••••" } }]);
});


for (const [replacement, masked] of [["test", "••••"], ["head-synthetic-replacement-tail", "head••••••••tail"]] as const) {
  test(`replaces the local header draft with the saved mask ${masked}`, async ({ page }) => {
    let attempts = 0;
    await page.route(`**${prefix}/configuration`, route => {
      if (route.request().method() !== "PUT") return route.fallback();
      const { expectedUpdatedAt: _revision, ...configuration } = route.request().postDataJSON();
      configurationWrites.push(configuration);
      attempts += 1;
      if (attempts === 1) return route.fulfill({ status: 503, json: { error: "Save unavailable" } });
      return route.fulfill({ json: { updatedAt: "2026-10-03T00:00:00Z", configuration: {
        ...configuration, agentName: "fixture-agent",
        mcpList: [{ name: serverName, headers: { "X-Shared": masked }, tools: ["lookup"] }],
      } } });
    });
    await page.goto(`${base}?role=owner`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const header = dialog.getByLabel("X-Shared", { exact: true });
    await dialog.getByRole("button", { name: "Replace", exact: true }).click();
    await header.fill(replacement);
    await dialog.getByRole("button", { name: "Show entered value", exact: true }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByText("Save unavailable", { exact: true })).toBeVisible();
    await expect(header).toHaveValue(replacement);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(header).toHaveValue(masked);
    await expect(header).toHaveAttribute("readonly", "");
    expect(configurationWrites[1]?.mcpList).toEqual([{ name: serverName, headers: { "X-Shared": replacement }, tools: ["lookup"] }]);
    await dialog.getByRole("button", { name: "Replace", exact: true }).click();
    await header.fill("another-draft");
    await header.fill("");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => configurationWrites.length).toBe(3);
    expect(configurationWrites[2]?.mcpList).toEqual([{ name: serverName, headers: { "X-Shared": masked }, tools: ["lookup"] }]);
  });
}

for (const width of [1440, 390]) {
  test(`evaluates a fresh run, reuses its result and marks changed criteria stale (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}?role=owner`);
    await expect(page.getByRole("button", { name: "Evaluation", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("textbox", { name: "Expected result", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Evaluation", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Create a report");
    await page.getByRole("combobox", { name: "Expected Skills", exact: true }).fill("report");
    await page.getByRole("combobox", { name: "Expected Skills", exact: true }).press("Enter");
    await page.getByRole("textbox", { name: "Expected result", exact: true }).fill("Include source links");
    await page.getByRole("button", { name: "Run and evaluate", exact: true }).click();
    await expect(page.getByText("The requested report is supported by the run.", { exact: true })).toBeVisible();
    expect(runRequests).toHaveLength(1);
    expect(runRequests[0]).toMatchObject({ captureEvaluation: true, expectedUpdatedAt: "2026-10-02T00:00:00Z" });
    expect(evaluationRequests[0]).toMatchObject({ token: "receipt-1", expectations: { skills: ["report"], tools: [], outcome: "Include source links" } });
    await expect(page.getByText("Meets criteria", { exact: true })).toHaveCount(4);
    await expect(page.getByText("Tool requests: 0 · Results received: 0", { exact: true })).toBeVisible();
    await expect(page.getByText("Offered", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Expected result", exact: true }).fill("Also include a conclusion");
    await expect(page.getByText(/This evaluation describes the previous result/)).toBeVisible();
    await page.getByRole("button", { name: "Evaluate result", exact: true }).click();
    await expect(page.getByRole("button", { name: "Evaluate result", exact: true })).toBeEnabled();
    expect(runRequests).toHaveLength(1);
    expect(evaluationRequests).toHaveLength(2);
    await expect(page.getByText(/This evaluation describes the previous result/)).toHaveCount(0);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Temporary edit");
    await expect(page.getByText(/This evaluation describes the previous result/)).toBeVisible();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Create a report");
    await expect(page.getByRole("button", { name: "Evaluate result", exact: true })).toBeEnabled();
    await expect(page.getByText(/This evaluation describes the previous result/)).toHaveCount(0);
    await page.getByRole("button", { name: "Recorded run evidence", exact: true }).click();
    await expect(page.locator("pre").filter({ hasText: "modelRequests" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`evaluation-${width}.png`), fullPage: true, animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width === 390) {
      const prompt = await page.getByRole("textbox", { name: "System prompt", exact: true }).boundingBox();
      const message = await page.getByRole("textbox", { name: "Message", exact: true }).boundingBox();
      expect(message!.width).toBeGreaterThan(280);
      expect(message!.y).toBeGreaterThan(prompt!.y + prompt!.height);
    }
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Create a different report");
    await page.getByRole("button", { name: "Run and evaluate", exact: true }).click();
    await expect(page.getByRole("button", { name: "Evaluate result", exact: true })).toBeEnabled();
    expect(runRequests).toHaveLength(2);
    expect(evaluationRequests.at(-1)?.token).toBe("receipt-2");
  });
}

test("reuses an explicitly started failed run and retries only evaluation after a judge failure", async ({ page }) => {
  runError = true;
  failEvaluation = true;
  await page.goto(`${base}?role=owner`);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Create a report");
  await page.getByRole("button", { name: "Run", exact: true }).last().click();
  await expect(page.getByText("Synthetic execution failure", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Evaluate result", exact: true }).click();
  await expect(page.getByText("Evaluation provider unavailable", { exact: true })).toBeVisible();
  failEvaluation = false;
  await page.getByRole("button", { name: "Evaluate result", exact: true }).click();
  await expect(page.getByText("The requested report is supported by the run.", { exact: true })).toBeVisible();
  expect(runRequests).toHaveLength(1);
  expect(evaluationRequests).toHaveLength(2);
});

test("does not replay a run with missing evidence and requires saving edited settings", async ({ page }) => {
  omitReceipt = true;
  await page.goto(`${base}?role=owner`);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Create a report");
  await page.getByRole("button", { name: "Run and evaluate", exact: true }).click();
  await expect(page.getByText(/The run did not return evaluation evidence/)).toBeVisible();
  await page.getByRole("button", { name: "Run and evaluate", exact: true }).click();
  expect(runRequests).toHaveLength(1);
  expect(evaluationRequests).toHaveLength(0);
  await page.getByRole("textbox", { name: "System prompt", exact: true }).fill("Updated instructions");
  await expect(page.getByRole("button", { name: "Run and evaluate", exact: true })).toBeDisabled();
  await expect(page.getByText(/Save your changes before evaluating/)).toBeVisible();
});

test("keeps evaluation alive when its section is collapsed", async ({ page }) => {
  let release: (() => void) | undefined;
  await page.route(`**${prefix}/evaluate`, async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fallback();
  });
  await page.goto(`${base}?role=owner`);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Create a report");
  await page.getByRole("button", { name: "Run and evaluate", exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  release!();
  await expect.poll(() => evaluationRequests.length).toBe(1);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await expect(page.getByText("The requested report is supported by the run.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Evaluate result", exact: true })).toBeEnabled();
  expect(runRequests).toHaveLength(1);
});
