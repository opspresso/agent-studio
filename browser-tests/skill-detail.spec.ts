import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/skill-detail.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-skill-detail-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "navigation-stub", setup(build) {
      build.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: "navigation-stub" }));
      build.onLoad({ filter: /.*/, namespace: "navigation-stub" }, args => ({
        contents: args.path === "next/navigation"
          ? "export const useParams = () => ({ name: window.__skillDetailName }); export const useRouter = () => ({ push() {} });"
          : 'import React from "react"; export default function Link(props) { return React.createElement("a", { href: props.href }, props.children); }',
        loader: "js", resolveDir: process.cwd(),
      }));
    } }],
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/skill-detail.css"><div id="root"></div><script src="/skill-detail.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test("does not offer the previous Skill's actions when the next Skill cannot be read", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const writes: string[] = [];
  await page.route("**/api/skills/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      writes.push(path);
      return route.fulfill({ status: 204 });
    }
    return path === "/api/skills/first"
      ? route.fulfill({ json: { name: "first", description: "First Skill", content: "First instructions", files: [], createdAt: "", updatedAt: "" } })
      : route.fulfill({ status: 503, json: { error: "Second Skill unavailable" } });
  });
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "first", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("Unsaved first Skill draft");
  await page.getByRole("button", { name: "Switch skill" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Second Skill unavailable" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("skill-read-failure.png"), fullPage: true });
  await expect(page.getByRole("heading", { name: "first", exact: true })).toHaveCount(0);
  for (const name of ["Edit", "Delete", "Save"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("textbox")).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
