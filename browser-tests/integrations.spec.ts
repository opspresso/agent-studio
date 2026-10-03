import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { TriggerRun } from "../src/domain/trigger/types";
import type { TriggerView } from "../src/application/trigger/triggerUseCases";

let server: Server;
let base: string;
let connected: boolean;
let channelReads: number;
let runs: Record<string, TriggerRun[]>;
let webhook: TriggerView | undefined;
let personalWebhook: boolean;
let credentialEvents: string[];
let refuseCredential: boolean;
let botSettingsUpdates: Array<{ kind: "slack" | "telegram" | "teams"; body: Record<string, unknown> }>;
const agentName = "fixture-agent";
const at = "2026-09-26T00:00:00Z";

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/integrations.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-integrations-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "navigation-stub", setup(build) {
      build.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: "navigation-stub" }));
      build.onLoad({ filter: /.*/, namespace: "navigation-stub" }, args => ({
        contents: args.path === "next/navigation"
          ? 'export const useParams = () => ({ name: "fixture-agent" }); export const usePathname = () => "/agents/fixture-agent/integrations"; export const useRouter = () => ({push(){}, refresh(){}});'
          : 'import React from "react"; export default function Link(props) { return React.createElement("a", { href: props.href }, props.children); }',
        loader: "js", resolveDir: process.cwd(),
      }));
    } }],
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/integrations.css"><div id="root"></div><script src="/integrations.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => {
  connected = false; channelReads = 0; runs = { daily: [], weekly: [] };
  webhook = undefined; personalWebhook = false; credentialEvents = []; refuseCredential = false;
  botSettingsUpdates = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const prefix = `/api/agents/${agentName}`;
    const botKind = path === `${prefix}/slack` ? "slack" : path === `${prefix}/telegram` ? "telegram" : path === `${prefix}/teams` ? "teams" : undefined;
    if (botKind && route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      expect(body).not.toHaveProperty("runAsOwner");
      botSettingsUpdates.push({ kind: botKind, body });
    }
    if (path === prefix) return route.fulfill({ json: { name: agentName, displayName: "Fixture", ownerEmail: "admin@example.test", createdAt: at, updatedAt: at,
      slack: { configured: connected, enabled: connected } } });
    if (path === `${prefix}/token`) return route.fulfill({ json: { configured: false, canIssue: true } });
    if (path === `${prefix}/webhook-token`) {
      const method = route.request().method();
      if (method === "DELETE") { credentialEvents.push("revoke"); personalWebhook = false; return route.fulfill({ status: 204 }); }
      if (method === "POST") {
        credentialEvents.push("generate");
        if (refuseCredential) return route.fulfill({ status: 403, json: { error: "Current Agent access is required" } });
        personalWebhook = true;
        webhook ??= { agentName, triggerId: "webhook", kind: "webhook", description: "", allowConcurrent: false, createdAt: at, updatedAt: at };
        return route.fulfill({ json: { token: "asw_synthetic-personal-token", credentialId: "personal-selector", masked: "asw_••••", createdAt: at } });
      }
      return route.fulfill({ json: { configured: personalWebhook, canIssue: true,
        ...(personalWebhook ? { credentialId: "personal-selector", masked: "asw_••••", createdAt: at } : {}) } });
    }
    if (path === `${prefix}/slack`) {
      if (route.request().method() === "PUT") connected = true;
      if (route.request().method() === "DELETE") { connected = false; return route.fulfill({ status: 204 }); }
      return route.fulfill({ json: { configured: connected, enabled: connected, botToken: connected ? "••••" : "", signingSecret: connected ? "••••" : "",
        eventsUrl: `${base}/events`, suggestedPrompts: [], channelKeywords: [], manifest: {} } });
    }
    if (path === `${prefix}/telegram`) return route.fulfill({ json: { configured: false, enabled: false, botToken: "", botUsername: "", webhookUrl: `${base}/telegram` } });
    if (path === `${prefix}/teams`) return route.fulfill({ json: { configured: false, enabled: false, appId: "", appPassword: "", tenantId: "", messagingUrl: `${base}/teams` } });
    if (path === `${prefix}/slack/channels`) {
      channelReads += 1;
      return route.fulfill({ json: { channels: [{ id: "channel", name: `reports-${channelReads}` }] } });
    }
    if (path === `${prefix}/triggers`) return route.fulfill({ json: { triggers: [...["daily", "weekly"].map(triggerId => ({ agentName, triggerId,
      kind: "schedule", createdBy: { userId: "registrar-id", email: "scheduler@example.test" }, enabled: true, allowConcurrent: false, cron: "0 9 * * *", timezone: "UTC", createdAt: at, updatedAt: at })), ...(webhook ? [webhook] : [])] } });
    if (path === `${prefix}/triggers/webhook` && route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      expect(body).not.toHaveProperty("runAsOwner");
      expect(body).not.toHaveProperty("enabled");
      webhook = { ...webhook!, ...body };
      return route.fulfill({ json: webhook });
    }
    if (path.endsWith("/runs")) {
      const triggerId = path.split("/").at(-2)!;
      return route.fulfill({ json: { runs: (runs[triggerId] ?? []).slice(0, Number(url.searchParams.get("limit") ?? 20)) } });
    }
    return route.abort();
  });
});

for (const [kind, label] of [["slack", "Slack bot"], ["telegram", "Telegram bot"], ["teams", "Microsoft Teams bot"]] as const) {
  test(`${label} uses personal account linking without owner delegation`, async ({ page }) => {
    await page.goto(base);
    await page.getByRole("button", { name: `${label} Not connected`, exact: true }).click();
    const region = page.getByRole("region", { name: `${label} Not connected`, exact: true });
    await expect(region.getByRole("link", { name: "Messaging connections", exact: true })).toHaveAttribute("href", "/profile/messaging");
    await expect(region.getByRole("switch", { name: /^Run with my permissions/ })).toHaveCount(0);
    await region.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => botSettingsUpdates.length).toBe(1);
    expect(botSettingsUpdates[0]?.kind).toBe(kind);
    expect(botSettingsUpdates[0]?.body).not.toHaveProperty("runAsOwner");
  });
}

test("personal Webhook tokens issue a caller URL and can be revoked independently", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole("button", { name: "Webhook Not configured", exact: true }).click();
  const control = page.getByRole("group", { name: "My Webhook token", exact: true });
  await control.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(control.getByRole("textbox")).toHaveValue("asw_synthetic-personal-token");
  await expect(page.getByText(`${base}/api/webhook/${agentName}?credential=personal-selector`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Webhook Configured", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Enabled", exact: true })).toHaveCount(0);
  await expect(control.getByText("Configured", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Webhook behavior", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("personal-webhook.png"), fullPage: true, animations: "disabled" });
  await control.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(control.getByRole("button", { name: "Generate", exact: true })).toBeVisible();
  await expect(control.getByRole("textbox")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Webhook Not configured", exact: true })).toBeVisible();
  await expect(page.getByText(/\?credential=personal-selector/)).toHaveCount(0);
  expect(credentialEvents).toEqual(["generate", "revoke"]);
  expect(errors).toEqual([]);
});

test("refused personal credential issuance preserves recovery without creating a caller URL", async ({ page }) => {
  refuseCredential = true;
  await page.goto(base);
  await page.getByRole("button", { name: "Webhook Not configured", exact: true }).click();
  const control = page.getByRole("group", { name: "My Webhook token", exact: true });
  await control.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(control.getByRole("alert")).toContainText("Current Agent access is required");
  await expect(control.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  await expect(page.getByText(/\?credential=/)).toHaveCount(0);
});

test("failed PR review history links its exact Workspace and Trace and displays the failure once", async ({ page }, testInfo) => {
  const error = "Review Workspace results were not read; no review was published";
  webhook = { agentName, triggerId: "webhook", kind: "webhook", description: "", allowConcurrent: false, createdAt: at, updatedAt: at };
  runs.webhook = [{ agentName, triggerId: "webhook", runId: "failed-review", status: "failed", startedAt: at,
    traceId: "review-trace", error, review: { repository: "fixture/repo", number: 42, headSha: "a".repeat(40),
      status: "failed", reason: error, workspaceUrl: `${base}/chats/review-workspace` } }];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`**/api/agents/${agentName}/configuration`, route => route.fulfill({ json: { configuration: null } }));
  await page.route("**/api/mcps", route => route.fulfill({ json: [] }));
  await page.goto(base);
  await page.getByRole("button", { name: "View history" }).nth(4).click();
  const table = page.getByRole("table");
  await expect(table.getByText("fixture/repo #42", { exact: true })).toBeVisible();
  await expect(table.getByRole("link", { name: "Workspace", exact: true })).toHaveAttribute("href", `${base}/chats/review-workspace`);
  await expect(table.getByRole("link", { name: "Trace", exact: true })).toHaveAttribute("href", `/agents/${agentName}/traces/review-trace`);
  await expect(table.getByText(error, { exact: true })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("failed-review-history.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a saved bot connection becomes a schedule destination without reloading the page", async ({ page }) => {
  await page.goto(base);
  await page.getByRole("button", { name: "Schedules 2" }).click();
  await expect(page.getByRole("combobox", { name: "Add destination" })).toHaveCount(0);
  await page.getByRole("button", { name: "Slack bot Not connected" }).click();
  await page.getByPlaceholder("xoxb-…", { exact: true }).fill("synthetic-token");
  await page.getByLabel("Signing secret", { exact: true }).fill("synthetic-secret");
  await page.getByRole("checkbox", { name: "Enable event handling at this URL" }).check();
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Slack bot Enabled" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Add destination" })).toHaveCount(2);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("button", { name: "Slack bot Not connected" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Add destination" })).toHaveCount(0);
});

test("replacing an enabled bot refreshes its destinations even when connection flags stay the same", async ({ page }) => {
  connected = true;
  await page.goto(base);
  await expect.poll(() => channelReads).toBe(1);
  await page.getByRole("button", { name: "Slack bot Enabled" }).click();
  await page.getByRole("button", { name: "Replace", exact: true }).first().click();
  await page.getByLabel(/^Bot token/).first().fill("synthetic-replacement");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect.poll(() => channelReads).toBe(2);
});

test("schedule history sorts by the actual start after a queue wait", async ({ page }) => {
  runs.daily = [{ agentName, triggerId: "daily", runId: "newer", status: "succeeded", queuedAt: "2026-09-26T08:00:00Z", startedAt: "2026-09-26T10:00:00Z", result: "Newer execution" }];
  runs.weekly = [{ agentName, triggerId: "weekly", runId: "older", status: "succeeded", queuedAt: "2026-09-26T08:30:00Z", startedAt: "2026-09-26T09:00:00Z", result: "Older execution" }];
  await page.goto(base);
  await page.getByRole("button", { name: "View history" }).nth(5).click();
  await expect(page.getByRole("table").getByRole("row").nth(1)).toContainText("Newer execution");
});

test("schedule history can show its full page when one schedule supplies the newest runs", async ({ page }) => {
  runs.daily = Array.from({ length: 52 }, (_, index) => ({ agentName, triggerId: "daily", runId: `run-${index}`, status: "succeeded",
    startedAt: new Date(Date.UTC(2026, 8, 26, 10, 52 - index)).toISOString(), result: `Result ${index}` }));
  await page.goto(base);
  await page.getByRole("button", { name: "View history" }).nth(5).click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(51);
});


test("schedules display their registering user without an owner delegation toggle", async ({ page }) => {
  await page.goto(base);
  await page.getByRole("button", { name: /Schedules/ }).first().click();
  await expect(page.getByText("Registered by: scheduler@example.test")).toHaveCount(2);
  await expect(page.getByRole("switch", { name: /^Run with my permissions/ })).toHaveCount(0);
});


test("a non-owner can manage personal tokens without shared Agent Webhook settings", async ({ page }) => {
  await page.goto(`${base}/?member`);
  await expect(page.getByRole("link", { name: "Integrations", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Webhook Not configured", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Webhook Not configured", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Enabled", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Webhook behavior", exact: true })).toHaveCount(0);
  await page.getByRole("group", { name: "My Webhook token", exact: true }).getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText(/\?credential=personal-selector/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Webhook Configured", exact: true })).toBeVisible();
});


test("MCP settings accept a constructor server name without inherited header rows", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/mcps/constructor", route => route.fulfill({ json: { name: "constructor", url: "https://mcp.example.test", headers: {}, tools: [], status: "needs_auth" } }));
  await page.route(`**/api/agents/${agentName}/mcp-connections`, route => route.fulfill({ json: { connections: [] } }));
  await page.goto(`${base}/?binding`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Header overrides", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
