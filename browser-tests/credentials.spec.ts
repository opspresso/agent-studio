import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["browser-tests/fixtures/credentials.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-credential-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? (file.path.endsWith(".css") ? "text/css" : "text/javascript") : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/credentials.css"><div id="root"></div><script src="/credentials.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => {
  await page.route("**/api/agents/fixture-agent/token", route => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { configured: true, masked: "ast_••••abcd", createdAt: "2026-09-26T00:00:00Z", revealable: true } });
    }
    if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
    if (route.request().method() === "POST") {
      return route.fulfill({ json: { token: "synthetic-new-agent-token", masked: "ast_••••wxyz", createdAt: "2026-09-26T00:00:00Z" } });
    }
    return route.abort();
  });
  await page.goto(base);
});

test("shows the Agent API token name once and keeps its status in the section title", async ({ page }) => {
  const section = page.getByRole("button", { name: "API token Configured" });
  await expect(section).toBeVisible();
  await section.click();
  const token = page.getByRole("group", { name: "API token" });
  await expect(token.getByRole("textbox", { name: "API token" })).toBeVisible();
  await expect(token.getByText("API token", { exact: true })).toHaveCount(0);
  await expect(token.getByText("Configured", { exact: true })).toHaveCount(0);

  await token.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("button", { name: "API token Not configured" })).toBeVisible();
  await token.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByRole("button", { name: "API token Configured" })).toBeVisible();
});

test("history button selects the integration without opening its settings", async ({ page }) => {
  const section = page.getByRole("button", { name: "API token Configured" });
  await expect(section).toHaveAttribute("aria-expanded", "false");
  await section.click();
  await expect(section).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("History selected")).toHaveText("false");
  await section.click();
  await expect(section).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("History selected")).toHaveText("false");
  await page.getByRole("button", { name: "View history" }).click();
  await expect(page.getByLabel("History selected")).toHaveText("true");
  await expect(section).toHaveAttribute("aria-expanded", "false");
});

test("keeps saved keys separate from replacement drafts and explicit reset", async ({ page }) => {
  const input = page.getByLabel("Provider key", { exact: false });
  const visibility = page.getByRole("button", { name: "Show entered value" }).first();
  await expect(input).toHaveValue("head••••••••tail");
  await expect(input).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "Replace", exact: true }).first().click();
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("type", "password");
  await input.fill("synthetic-replacement");
  await visibility.click();
  await expect(input).toHaveAttribute("type", "text");
  await input.fill("");
  await expect(input).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Input unchanged")).toHaveText("true");
  await page.getByRole("button", { name: "Reset to environment", exact: true }).first().click();
  await expect(page.getByLabel("Input unchanged")).toHaveText("false");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Input unchanged")).toHaveText("true");
  await page.getByRole("button", { name: "Replace", exact: true }).first().click();
  await input.fill("synthetic-next");
  await page.getByRole("button", { name: "Save provider" }).click();
  await expect(input).toHaveValue("next••••••••tail");
  await expect(input).toHaveAttribute("readonly", "");
});

test("shows and copies only a revealed value, and discards it on hide or resource change", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const token = page.getByRole("group", { name: "Agent token", exact: true });
  await expect(page.getByLabel("Operations", { exact: true })).toHaveText("none");
  await expect(token.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
  await token.getByRole("button", { name: "Show", exact: true }).click();
  await expect(token.getByRole("textbox")).toHaveValue("synthetic-revealed-key");
  await token.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("synthetic-revealed-key");
  await token.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(token.getByRole("textbox")).not.toHaveValue("synthetic-revealed-key");
  await expect(token.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
  await token.getByRole("button", { name: "Show", exact: true }).click();
  await page.getByRole("button", { name: "Change agent" }).click();
  await expect(page.getByRole("textbox", { name: "Other agent token" })).not.toHaveValue("synthetic-revealed-key");
});

test("finishes replacement even when the saved key has identical visible edges and length", async ({ page }) => {
  const input = page.getByLabel("Provider key", { exact: false });
  await page.getByRole("button", { name: "Replace", exact: true }).first().click();
  await input.fill("head-synthetic-replacement-tail");
  await page.getByRole("button", { name: "Save with unchanged mask" }).click();
  await expect(input).toHaveAttribute("readonly", "");
  await expect(input).toHaveValue("head••••••••tail");
});

test("confirms replacement and revocation, and returns to generation after revocation", async ({ page }) => {
  const token = page.getByRole("group", { name: "Agent token", exact: true });
  await token.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("stops working immediately");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Operations", { exact: true })).toHaveText("none");
  await token.getByRole("button", { name: "Regenerate", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(token.getByRole("textbox")).toHaveValue("synthetic-generated-key");
  await token.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(token.getByRole("textbox")).toHaveValue("");
  await expect(token.getByRole("button", { name: "Show", exact: true })).toHaveCount(0);
  await token.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Operations", { exact: true })).toHaveText("generate,revoke,generate");
});

test("manual replacement and reset share confirmation and clear plaintext", async ({ page }) => {
  const token = page.getByRole("group", { name: "Agent token", exact: true });
  await token.getByRole("button", { name: "Enter a value" }).click();
  await token.getByLabel("New key or token").fill("synthetic-manual-key");
  await token.getByLabel("New key or token").press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Operations", { exact: true })).toHaveText("none");
  await page.getByRole("dialog").getByRole("button", { name: "Save key", exact: true }).click();
  await expect(token.getByLabel("New key or token")).toHaveCount(0);
  await expect(token.getByRole("textbox")).not.toHaveValue("synthetic-manual-key");
  await token.getByRole("button", { name: "Reset to environment" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset to environment" }).click();
  await expect(page.getByLabel("Operations", { exact: true })).toHaveText("save,reset");
});

test("blocks overlapping operations and preserves recovery after a failed reveal", async ({ page }) => {
  const token = page.getByRole("group", { name: "Agent token", exact: true });
  await page.getByLabel("Hold operations").check();
  await page.getByLabel("Fail operations").check();
  await token.getByRole("button", { name: "Show", exact: true }).click();
  await expect(token.getByRole("button", { name: "Regenerate", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Complete operation" }).click();
  await expect(token.getByRole("alert")).toContainText("Credential service unavailable");
  await expect(token.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
  await page.getByLabel("Fail operations").uncheck();
  await page.getByLabel("Hold operations").uncheck();
  await token.getByRole("button", { name: "Show", exact: true }).click();
  await expect(token.getByRole("textbox")).toHaveValue("synthetic-revealed-key");
  await expect(token.getByRole("alert")).toHaveCount(0);
});

test("header editors preserve a saved value when a replacement is cleared", async ({ page }) => {
  const header = page.getByLabel("Authorization", { exact: true });
  await expect(header).toHaveValue("head••••••••tail");
  await page.getByRole("button", { name: "Replace", exact: true }).last().click();
  await header.fill("synthetic-header");
  await expect(page.getByLabel("Header unchanged")).toHaveText("false");
  await header.fill("");
  await expect(page.getByLabel("Header unchanged")).toHaveText("true");
});
