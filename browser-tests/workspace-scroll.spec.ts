import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { WorkspaceDetailResponse } from "../src/app/api/workspaces/[id]/route";
import type { WorkspaceEventsResponse } from "../src/app/api/workspaces/[id]/events/route";

let server: Server;
let base: string;

const now = "2026-09-23T00:00:00Z";
const detail: WorkspaceDetailResponse = {
  workspace: { id: "workspace-1", chatId: "chat-1", projectName: "project",
    title: "Long running workspace", runtime: "command", sessionId: "session-1", status: "active",
    revision: 1, createdAt: now, updatedAt: now, dueAt: now, idleTtlSeconds: 3600, activeRunId: "run-1" },
  session: null,
  runs: [{ id: "run-1", workspaceId: "workspace-1", sessionId: "session-1",
    input: { kind: "command", script: "make output" }, status: "running", createdAt: now,
    lastEventSeq: 2, checks: [] }],
  approvals: [],
};
const output = Array.from({ length: 160 }, (_, index) => `output line ${index + 1}`).join("\n");
const events: WorkspaceEventsResponse = { events: [{ workspaceId: "workspace-1", runId: "run-1", seq: 1, createdAt: now,
  data: { kind: "output", stream: "stdout", text: output } }], nextSeq: 1, hasMore: false };

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/workspace-panel.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-workspace-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workspace-panel.css"><div id="root"></div><script src="/workspace-panel.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test("opens at the latest output without animated history traversal and respects manual scrolling", async ({ page }) => {
  let append = false;
  let emptyFirstPoll = true;
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const observer = new MutationObserver(() => {
        if (!document.body.textContent?.includes("output line 160")) return;
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const viewport = document.querySelector('[data-testid="workspace-scroll-area"] .mantine-ScrollArea-viewport');
          if (viewport) (window as Window & { __landingGap?: number }).__landingGap =
            viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
        }));
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  });
  await page.route("**/api/workspaces/options", route => route.fulfill({ json: { projects: [] } }));
  await page.route("**/api/workspaces/workspace-1**", route => route.fulfill({ json: detail }));
  await page.route("**/api/workspaces/workspace-1/events?**", route => {
    const after = Number(new URL(route.request().url()).searchParams.get("after"));
    if (after === 0 && emptyFirstPoll) {
      emptyFirstPoll = false;
      return route.fulfill({ json: { events: [], nextSeq: 0, hasMore: false } satisfies WorkspaceEventsResponse });
    }
    if (after === 0) return route.fulfill({ json: events });
    if (append && after === 1) return route.fulfill({ json: { events: [{ workspaceId: "workspace-1", runId: "run-1",
      seq: 2, createdAt: now, data: { kind: "output", stream: "stdout", text: "\nappended output" } }], nextSeq: 2, hasMore: false } satisfies WorkspaceEventsResponse });
    return route.fulfill({ json: { events: [], nextSeq: after, hasMore: false } satisfies WorkspaceEventsResponse });
  });
  await page.goto(base);
  const viewport = page.getByTestId("workspace-scroll-area").locator(".mantine-ScrollArea-viewport");
  await expect(page.getByText("output line 160", { exact: false })).toBeAttached();
  await expect.poll(() => page.evaluate(() => (window as Window & { __landingGap?: number }).__landingGap)).toBeLessThan(3);
  await expect.poll(() => viewport.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(3);

  await viewport.hover();
  await page.mouse.wheel(0, -3000);
  await expect(page.getByRole("button", { name: "Latest" })).toBeVisible();
  const beforeAppend = await viewport.evaluate(element => element.scrollTop);
  append = true;
  await expect(page.getByText("appended output", { exact: false })).toBeAttached();
  expect(await viewport.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(beforeAppend + 3);
  await page.getByRole("button", { name: "Latest" }).click();
  await expect.poll(() => viewport.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(3);
});

test("keeps an output read failure visible when workspace detail refreshes", async ({ page }) => {
  let detailReads = 0;
  let eventReads = 0;
  await page.route("**/api/workspaces/options", route => route.fulfill({ json: { projects: [] } }));
  await page.route("**/api/workspaces/workspace-1**", route => {
    detailReads += 1;
    return route.fulfill({ json: detail });
  });
  await page.route("**/api/workspaces/workspace-1/events?**", async route => {
    eventReads += 1;
    if (eventReads === 1) return route.fulfill({ status: 503, json: { error: "Output store unavailable" } });
    await new Promise(resolve => setTimeout(resolve, 3000));
    return route.fulfill({ json: { events: [], nextSeq: 0, hasMore: false } satisfies WorkspaceEventsResponse });
  });
  await page.goto(base);
  await expect(page.getByText("Output store unavailable")).toBeVisible();
  await expect.poll(() => detailReads).toBeGreaterThan(1);
  await expect(page.getByText("Output store unavailable")).toBeVisible();
});
