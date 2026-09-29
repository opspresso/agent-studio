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
let executionUpdates: boolean[];
let refuseExecutionGrant: boolean;
let botPermissions: Record<"slack" | "telegram" | "teams", boolean>;
let botPermissionUpdates: Array<{ kind: "slack" | "telegram" | "teams"; runAsOwner: boolean }>;
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
          ? 'export const useParams = () => ({ name: "fixture-agent" });'
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
  webhook = undefined; executionUpdates = []; refuseExecutionGrant = false;
  botPermissions = { slack: false, telegram: false, teams: false }; botPermissionUpdates = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const prefix = `/api/agents/${agentName}`;
    const botKind = path === `${prefix}/slack` ? "slack" : path === `${prefix}/telegram` ? "telegram" : path === `${prefix}/teams` ? "teams" : undefined;
    if (botKind && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { runAsOwner?: boolean };
      if (body.runAsOwner !== undefined) {
        botPermissions[botKind] = body.runAsOwner;
        botPermissionUpdates.push({ kind: botKind, runAsOwner: body.runAsOwner });
      }
    }
    if (path === prefix) return route.fulfill({ json: { name: agentName, displayName: "Fixture", ownerEmail: "admin@example.test", createdAt: at, updatedAt: at,
      slack: { configured: connected, enabled: connected } } });
    if (path === `${prefix}/token`) return route.fulfill({ json: { configured: false } });
    if (path === `${prefix}/slack`) {
      if (route.request().method() === "PUT") connected = true;
      if (route.request().method() === "DELETE") { connected = false; return route.fulfill({ status: 204 }); }
      return route.fulfill({ json: { runAsOwner: botPermissions.slack, configured: connected, enabled: connected, botToken: connected ? "••••" : "", signingSecret: connected ? "••••" : "",
        eventsUrl: `${base}/events`, suggestedPrompts: [], channelKeywords: [], manifest: {} } });
    }
    if (path === `${prefix}/telegram`) return route.fulfill({ json: { runAsOwner: botPermissions.telegram, configured: false, enabled: false, botToken: "", botUsername: "", webhookUrl: `${base}/telegram` } });
    if (path === `${prefix}/teams`) return route.fulfill({ json: { runAsOwner: botPermissions.teams, configured: false, enabled: false, appId: "", appPassword: "", tenantId: "", messagingUrl: `${base}/teams` } });
    if (path === `${prefix}/slack/channels`) {
      channelReads += 1;
      return route.fulfill({ json: { channels: [{ id: "channel", name: `reports-${channelReads}` }] } });
    }
    if (path === `${prefix}/triggers`) return route.fulfill({ json: { triggers: [...["daily", "weekly"].map(triggerId => ({ agentName, triggerId,
      kind: "schedule", enabled: true, allowConcurrent: false, cron: "0 9 * * *", timezone: "UTC", createdAt: at, updatedAt: at })), ...(webhook ? [webhook] : [])] } });
    if (path === `${prefix}/triggers/webhook` && route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { runAsOwner: boolean };
      executionUpdates.push(body.runAsOwner);
      if (refuseExecutionGrant) return route.fulfill({ status: 403, json: { error: "Only the owner can enable personal execution" } });
      webhook = { ...webhook!, executionEmail: body.runAsOwner ? "admin@example.test" : undefined };
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
  test(`${label} execution permissions require Save and can be revoked`, async ({ page }) => {
    await page.goto(base);
    await page.getByRole("button", { name: `${label} Not connected`, exact: true }).click();
    const region = page.getByRole("region", { name: `${label} Not connected`, exact: true });
    const permission = region.getByRole("switch", { name: /^Run with my permissions/ });
    await expect(permission).not.toBeChecked();
    await permission.click();
    expect(botPermissionUpdates).toEqual([]);
    await region.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => botPermissionUpdates).toEqual([{ kind, runAsOwner: true }]);
    const updatedRegion = page.getByRole("region", { name: new RegExp(`^${label}`) });
    const updatedPermission = updatedRegion.getByRole("switch", { name: /^Run with my permissions/ });
    await expect(updatedPermission).toBeChecked();
    await expect(updatedPermission).toBeEnabled();
    await updatedPermission.click();
    await updatedRegion.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => botPermissionUpdates).toEqual([{ kind, runAsOwner: true }, { kind, runAsOwner: false }]);
    await expect(updatedPermission).not.toBeChecked();
  });
}

test("Webhook execution permissions are off by default and can be explicitly granted and revoked", async ({ page }, testInfo) => {
  page.on("pageerror", error => { throw error; });
  webhook = { agentName, triggerId: "webhook", kind: "webhook", enabled: true, allowConcurrent: false,
    description: "", secretMasked: "••••", createdAt: at, updatedAt: at };
  await page.goto(base);
  await page.getByRole("button", { name: "Webhook enabled", exact: true }).click();
  const permission = page.getByRole("switch", { name: /^Run with my permissions/ });
  await expect(permission).not.toBeChecked();
  await expect(page.getByText(/Authorized webhook senders can use your configured personal tools and Workspaces/)).toBeVisible();
  await permission.click();
  await expect(permission).toBeChecked();
  await expect(permission).toBeEnabled();
  expect(executionUpdates).toEqual([true]);
  await page.screenshot({ path: testInfo.outputPath("webhook-execution-permissions.png"), fullPage: true, animations: "disabled" });
  await permission.click();
  await expect(permission).not.toBeChecked();
  await expect(permission).toBeEnabled();
  expect(executionUpdates).toEqual([true, false]);
});

test("Webhook execution permission stays off when the server refuses the grant", async ({ page }) => {
  webhook = { agentName, triggerId: "webhook", kind: "webhook", enabled: true, allowConcurrent: false,
    description: "", secretMasked: "••••", createdAt: at, updatedAt: at };
  refuseExecutionGrant = true;
  await page.goto(base);
  await page.getByRole("button", { name: "Webhook enabled", exact: true }).click();
  const permission = page.getByRole("switch", { name: /^Run with my permissions/ });
  await permission.click();
  await expect(page.getByRole("alert")).toContainText("Only the owner can enable personal execution");
  await expect(permission).not.toBeChecked();
  await expect(permission).toBeEnabled();
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
