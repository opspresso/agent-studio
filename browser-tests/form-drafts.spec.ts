import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import { translator } from "../src/app/_i18n/translate";
import { DEFAULT_CALL_ROUTING_POLICY } from "../src/domain/llm/callRouting";

const t = translator("en");
const agent = { name: "fixture", displayName: "Fixture", description: "Description", ownerEmail: "owner@example.test", visibility: "public", costLimits: {} };
let server: Server;
let base: string;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/form-drafts.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-form-drafts", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "navigation", setup(build) {
      build.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: "navigation" }));
      build.onLoad({ filter: /.*/, namespace: "navigation" }, args => ({
        contents: args.path === "next/navigation"
          ? 'export const useParams = () => ({ name: "fixture" }); export const useRouter = () => ({ push() {}, replace() {} });'
          : 'import React from "react"; export default function Link(props) { return React.createElement("a", props); }',
        loader: "js", resolveDir: process.cwd(),
      }));
    } }],
  });
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = bundle.outputFiles.find(file => path === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html");
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/form-drafts.css"><div id="root"></div><script src="/form-drafts.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/agents/fixture") return route.fulfill({ json: agent });
    if (path === "/api/models/routing") return route.fulfill({ json: { policy: DEFAULT_CALL_ROUTING_POLICY } });
    if (path === "/api/skills") return route.fulfill({ json: [] });
    if (path === "/api/skills/fixture") return route.fulfill({ json: { name: "fixture", description: "Original", content: "Original instructions", files: [] } });
    if (path === "/api/mcps/fixture") return route.fulfill({ json: { name: "fixture", url: "https://mcp.example.test", description: "Original", content: "Original notes", headers: {} } });
    return route.abort();
  });
});

for (const kind of ["metadata", "visibility", "cost"] as const) {
  test(`Agent ${kind} keeps the submitted draft stable and clears saved feedback after editing`, async ({ page }) => {
    const requested = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let submitted: Record<string, unknown> | undefined;
    await page.route("**/api/agents/fixture", async route => {
      if (route.request().method() !== "PUT") return route.fallback();
      submitted = route.request().postDataJSON();
      requested.resolve();
      await finish.promise;
      return route.fulfill({ json: { ...agent, ...submitted } });
    });
    await page.goto(base);
    if (kind !== "metadata") await page.getByRole("button", { name: new RegExp(t(kind === "visibility" ? "pset.visibility" : "pset.costLimits")) }).click();
    const input = kind === "metadata" ? page.getByLabel(t("agents.displayName"), { exact: true })
      : kind === "visibility" ? page.getByRole("radio", { name: t("pset.visibilityPrivate"), exact: true })
      : page.getByLabel(t("pset.blockThreshold"), { exact: true });
    if (kind === "visibility") await input.check(); else await input.fill(kind === "cost" ? "12" : "New name");
    await page.getByRole("button", { name: t(kind === "metadata" ? "common.saveChanges" : kind === "visibility" ? "pset.visibilitySave" : "pset.saveCostLimits"), exact: true }).click();
    await requested.promise;
    try { await expect(input).toBeDisabled(); } finally { finish.resolve(); }
    await expect(input).toBeEnabled();
    await expect(page.getByText(t("common.saved"), { exact: true })).toBeVisible();
    if (kind === "visibility") await page.getByRole("radio", { name: t("pset.visibilityPublic"), exact: true }).check();
    else await input.fill(kind === "cost" ? "13" : "Unsaved name");
    await expect(page.getByText(t("common.saved"), { exact: true })).toHaveCount(0);
    expect(submitted).toMatchObject(kind === "metadata" ? { displayName: "New name" } : kind === "visibility" ? { visibility: "private" } : { costLimits: { blockThresholdUsd: 12 } });
  });
}

test("shared model routing freezes its draft until a failed save returns", async ({ page }) => {
  const requested = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  await page.route("**/api/models/routing", async route => {
    if (route.request().method() !== "PUT") return route.fallback();
    requested.resolve(); await finish.promise;
    return route.fulfill({ status: 503, json: { error: "Routing save unavailable" } });
  });
  await page.goto(`${base}?page=routing`);
  await page.getByRole("button", { name: t("routing.advanced"), exact: true }).click();
  const input = page.getByRole("checkbox", { name: t("routing.localOnly"), exact: true });
  await input.check();
  await page.getByRole("button", { name: t("routing.saveShared"), exact: true }).click();
  await requested.promise;
  try { await expect(input).toBeDisabled(); } finally { finish.resolve(); }
  await expect(page.getByRole("alert")).toContainText("Routing save unavailable");
  await expect(input).toBeEnabled();
  await expect(input).toBeChecked();
});

test("new Skill modal freezes fields and retains the draft after a refused write", async ({ page }) => {
  const requested = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  await page.route("**/api/skills", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    requested.resolve(); await finish.promise;
    return route.fulfill({ status: 503, json: { error: "Skill save unavailable" } });
  });
  await page.goto(`${base}?page=skills`);
  await page.getByRole("button", { name: t("skills.new"), exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: t("registry.nameLabel"), exact: true }).fill("new-skill");
  const description = dialog.getByRole("textbox", { name: t("registry.description"), exact: true });
  await description.fill("Keep this draft");
  await dialog.getByRole("button", { name: t("registry.create"), exact: true }).click();
  await requested.promise;
  try { await expect(description).toBeDisabled(); } finally { finish.resolve(); }
  await expect(dialog.getByRole("alert")).toContainText("Skill save unavailable");
  await expect(description).toBeEnabled();
  await expect(description).toHaveValue("Keep this draft");
});

for (const [kind, endpoint] of [["skill", "skills"], ["mcp", "mcps"]] as const) {
  test(`${kind} edit cannot change or cancel a pending write`, async ({ page }) => {
    const requested = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    await page.route(`**/api/${endpoint}/fixture`, async route => {
      if (route.request().method() !== "PUT") return route.fallback();
      requested.resolve(); await finish.promise;
      return route.fulfill({ status: 503, json: { error: "Write unavailable" } });
    });
    await page.goto(`${base}?page=${kind}`);
    await page.getByRole("button", { name: t("common.edit"), exact: true }).click();
    const description = page.getByRole("textbox", { name: t("registry.description"), exact: true });
    await description.fill("Keep this edit");
    await page.getByRole("button", { name: t("common.save"), exact: true }).click();
    await requested.promise;
    try {
      await expect(description).toBeDisabled();
      await expect(page.getByRole("button", { name: t("common.cancel"), exact: true })).toBeDisabled();
    } finally { finish.resolve(); }
    await expect(page.getByRole("alert").filter({ hasText: "Write unavailable" })).toBeVisible();
    await expect(description).toBeEnabled();
    await expect(description).toHaveValue("Keep this edit");
  });
}
