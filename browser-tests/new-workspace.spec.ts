import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { WorkspaceOptionsResponse } from "../src/app/api/workspaces/options/route";

let server: Server;
let base: string;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/new-workspace.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-new-workspace-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "navigation-stub", setup(build) {
      build.onResolve({ filter: /^next\/navigation$/ }, args => ({ path: args.path, namespace: "navigation-stub" }));
      build.onLoad({ filter: /.*/, namespace: "navigation-stub" }, () => ({
        contents: "export const useRouter = () => ({ push() {} });", loader: "js",
      }));
    } }],
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/new-workspace.css"><div id="root"></div><script src="/new-workspace.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test("clears an options read error on retry while preserving the drafted task", async ({ page }) => {
  let reads = 0;
  const options: WorkspaceOptionsResponse = { enabled: true, gitEnabled: false, projects: [{
    projectName: "agent", displayName: "Agent", description: "", runtimes: ["command"],
    defaultRuntime: "command", mode: "selected", repositories: [], repositoryOwners: [], deploymentWorkflows: [],
  }] };
  await page.route("**/api/workspaces/options", route => {
    reads += 1;
    return reads === 1
      ? route.fulfill({ status: 503, json: { error: "Options store unavailable" } })
      : route.fulfill({ json: options });
  });
  await page.goto(base);
  await expect(page.getByRole("alert")).toContainText("Options store unavailable");
  await page.getByLabel("Script").fill("make output");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Script")).toHaveValue("make output");
  await expect(page.getByRole("button", { name: "Start" })).toBeEnabled();
  expect(reads).toBe(2);
});

test("keeps the selected project after a failed refresh and retry", async ({ page }) => {
  let reads = 0;
  const projects: WorkspaceOptionsResponse["projects"] = ["agent", "other"].map(name => ({
    projectName: name, displayName: name === "agent" ? "Agent" : "Other", description: "", runtimes: ["command"],
    defaultRuntime: "command", mode: "selected", repositories: [], repositoryOwners: [], deploymentWorkflows: [],
  }));
  await page.route("**/api/workspaces/options", route => {
    reads += 1;
    return reads === 2
      ? route.fulfill({ status: 503, json: { error: "Options store unavailable" } })
      : route.fulfill({ json: { enabled: true, gitEnabled: false, projects } satisfies WorkspaceOptionsResponse });
  });
  await page.goto(base);
  await page.getByRole("combobox", { name: "Agent" }).click();
  await page.getByRole("option", { name: "Other" }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Options store unavailable");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Agent" })).toHaveValue("Other");
  expect(reads).toBe(3);
});
