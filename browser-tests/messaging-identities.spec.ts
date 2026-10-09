import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["browser-tests/fixtures/messaging-identities.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-messaging-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? (file.path.endsWith(".css") ? "text/css" : "text/javascript") : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/messaging-identities.css"><div id="root"></div><script src="/messaging-identities.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
  await page.route("**/api/agents", route => route.fulfill({ json: [{ name: "fixture", displayName: "Fixture Agent" }] }));
  await page.route("**/api/me/messaging-identities", route => route.fulfill({ json: { identities: [] } }));
});

test("issues a scoped code, clears it on selection changes and expires it", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install();
  await page.route("**/api/me/messaging-identities", async route => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { identities: [] } });
    expect(route.request().postDataJSON()).toEqual({ agentName: "fixture", platform: "slack" });
    return route.fulfill({ json: { code: "synthetic-link-code", expiresAt: new Date(await page.evaluate(() => Date.now()) + 600_000).toISOString() } });
  });
  await page.goto(base);
  await page.getByRole("button", { name: "Issue authentication code" }).click();
  await expect(page.getByText("auth synthetic-link-code", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("messaging-connections.png"), fullPage: true });
  await page.clock.fastForward(601_000);
  await expect(page.getByText("auth synthetic-link-code", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Issue authentication code" }).click();
  await expect(page.getByText("auth synthetic-link-code", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Messaging platform" }).click();
  await page.getByRole("option", { name: "Telegram" }).click();
  await expect(page.getByText("auth synthetic-link-code", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("shows an issuance failure and lets the user retry", async ({ page }) => {
  await page.route("**/api/me/messaging-identities", route => route.request().method() === "POST"
    ? route.fulfill({ status: 403, json: { error: "Agent access revoked" } })
    : route.fulfill({ json: { identities: [] } }));
  await page.goto(base);
  await page.getByRole("button", { name: "Issue authentication code" }).click();
  await expect(page.getByRole("alert")).toContainText("Agent access revoked");
  await expect(page.getByRole("button", { name: "Issue authentication code" })).toBeEnabled();
});

test("lists personal connections for guests and disconnects them without attempting issuance", async ({ page }) => {
  const identity = { agentName: "fixture", platform: "slack", realm: "workspace", externalId: "sender", userId: "studio-user", linkedAt: "2026-10-01T00:00:00Z" };
  let linked = true;
  await page.route("**/api/me/messaging-identities", route => {
    if (route.request().method() === "DELETE") {
      expect(route.request().postDataJSON()).toEqual(identity);
      linked = false;
      return route.fulfill({ status: 204 });
    }
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: { identities: linked ? [identity] : [] } });
  });
  await page.goto(`${base}/?guest`);
  await expect(page.getByRole("button", { name: "Issue authentication code" })).toBeDisabled();
  await expect(page.getByText("workspace · sender")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("workspace · sender")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
