import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { EngineChunk } from "../src/domain/llm/types";

let server: Server;
let base: string;
let pending: { response: ServerResponse; second: string } | undefined;
const write = (response: ServerResponse, chunk: EngineChunk) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/run-panel.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-run-panel-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  });
  server = createServer((request, response) => {
    if (request.url === "/finish" || request.url === "/fail" || request.url === "/interrupt") {
      if (!pending) { response.writeHead(409); response.end(); return; }
      const held = pending;
      pending = undefined;
      if (request.url === "/fail") write(held.response, { error: "Synthetic provider failure" });
      else if (request.url === "/finish") {
        write(held.response, { author: held.second, transferId: "call_1", authorDone: true });
        write(held.response, { delta: { content: "Parent synthesis" } });
        write(held.response, { done: true });
      }
      held.response.end();
      response.end("finished");
      return;
    }
    if (request.url === "/api/agents/root/agent") {
      let body = "";
      request.on("data", data => { body += String(data); });
      request.on("end", () => {
        const same = JSON.parse(body).messages[0].content === "same";
        const first = same ? "child" : "alpha";
        const second = same ? "child" : "beta";
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        write(response, { author: first, transferId: "call_0", delta: { content: "First child" } });
        write(response, { author: second, transferId: "call_1", delta: { content: "Second child" } });
        write(response, { author: first, transferId: "call_0", authorDone: true });
        write(response, { toolResult: { toolCallId: "call_0", name: `delegate_${first}: ${first}`, content: "First result" } });
        write(response, { warning: "Synthetic warning while the second child runs" });
        pending = { response, second };
      });
      return;
    }
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/run-panel.css"><div id="root"></div><script src="/run-panel.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterEach(() => { pending?.response.end(); pending = undefined; });
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

for (const same of [false, true]) {
  test(`keeps the remaining invocation badge after a sibling result (same Agent: ${same})`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base);
    await page.getByRole("textbox").fill(same ? "same" : "different");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const activity = page.getByText("running:", { exact: true }).locator("..");
    await expect(activity.getByText(same ? "child" : "beta", { exact: true })).toBeVisible();
    if (!same) await expect(activity.getByText("alpha", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /^Agent (alpha|child)/ }).click();
    await expect(page.getByText("First result", { exact: true })).toBeVisible();
    await expect(page.getByText("Synthetic warning while the second child runs", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("active-invocation.png") });
    expect((await page.request.get(`${base}/finish`)).status()).toBe(200);
    await expect(page.getByText("Parent synthesis", { exact: true })).toBeVisible();
    const finished = page.getByText("ran:", { exact: true }).locator("..");
    await expect(finished.getByText(same ? "child" : "beta", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

for (const ending of ["fail", "interrupt"] as const) {
  test(`clears active invocation badges when the stream ends through ${ending}`, async ({ page }) => {
    await page.goto(base);
    await page.getByRole("textbox").fill("different");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const activity = page.getByText("running:", { exact: true }).locator("..");
    await expect(activity.getByText("beta", { exact: true })).toBeVisible();
    expect((await page.request.get(`${base}/${ending}`)).status()).toBe(200);
    const finished = page.getByText("ran:", { exact: true }).locator("..");
    await expect(finished).toBeVisible();
    await expect(finished.getByText("beta", { exact: true })).toHaveCount(0);
    await expect(page.getByText("agents involved: alpha, beta", { exact: true })).toBeVisible();
    if (ending === "fail") await expect(page.getByText("Synthetic provider failure", { exact: true })).toBeVisible();
  });
}
