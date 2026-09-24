import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { AuditPage } from "../src/application/audit/auditUseCases";

let server: Server;
let base: string;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/audit.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-audit-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find((item) => request.url === `/${item.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/audit.css"><div id="root"></div><script src="/audit.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

test("loads another audit page and keeps the existing rows in order", async ({ page }) => {
  const cursors: Array<string | null> = [];
  await page.route("**/api/audit?**", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    const event = (id: string, createdAt: string) => ({
      eventId: id, actorEmail: "admin@example.test", action: "settings.update" as const,
      target: `settings:${id}`, createdAt,
    });
    const body: AuditPage = cursor
      ? { events: [event("older", "2026-08-02T10:00:00.000Z")], nextCursor: null }
      : { events: [event("newer", "2026-08-03T10:00:00.000Z")], nextCursor: "next-page" };
    return route.fulfill({ json: body });
  });

  await page.goto(base);
  await expect(page.getByText("settings:newer")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("settings:older")).toBeVisible();
  expect(cursors).toEqual([null, "next-page"]);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(await page.locator("tbody tr td:nth-child(4)").allTextContents())
    .toEqual(["settings:newer", "settings:older"]);
});
