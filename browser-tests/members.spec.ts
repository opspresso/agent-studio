import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { Member } from "../src/domain/member/types";

let server: Server;
let base: string;
const members: Member[] = ["first", "second"].map(id => ({
  id, name: id, email: `${id}@example.test`, tier: "member", image: null,
  joinedAt: "2026-09-27T00:00:00Z", lastLoginAt: null,
}));

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/members.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-members-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/members.css"><div id="root"></div><script src="/members.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

for (const firstStatus of [200, 500]) {
  test(`each member's tier remains locked until its own request settles (first status ${firstStatus})`, async ({ page }, testInfo) => {
    const pending = new Map<string, () => Promise<void>>();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/api/members**", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: {
        members: members.map(member => ({ ...member, tierLocked: false })),
      } });
      const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
      const member = members.find(member => member.id === id)!;
      const { tier } = route.request().postDataJSON();
      pending.set(id, () => route.fulfill({
        status: id === "first" ? firstStatus : 200,
        json: id === "first" && firstStatus === 500 ? { error: "Synthetic tier update failed" } : { ...member, tier },
      }));
      return;
    });
    try {
      await page.goto(base);
      const first = page.getByRole("combobox", { name: "Tier of first@example.test" });
      const second = page.getByRole("combobox", { name: "Tier of second@example.test" });
      await expect(first).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("members.png") });
      await first.click();
      await page.getByRole("option", { name: "admin", exact: true }).click();
      await expect.poll(() => pending.has("first")).toBe(true);
      await expect(first).toBeDisabled();
      await second.click();
      await page.getByRole("option", { name: "guest", exact: true }).click();
      await expect.poll(() => pending.has("second")).toBe(true);
      await expect(second).toBeDisabled();
      await expect(first).toBeDisabled();
      await pending.get("first")!();
      pending.delete("first");
      await expect(first).toBeEnabled();
      await expect(first).toHaveValue(firstStatus === 200 ? "admin" : "member");
      await expect(second).toBeDisabled();
      await pending.get("second")!();
      pending.delete("second");
      await expect(second).toBeEnabled();
      await expect(second).toHaveValue("guest");
      if (firstStatus === 500) await expect(page.getByRole("alert").first()).toContainText("Synthetic tier update failed");
      expect(pageErrors).toEqual([]);
    } finally {
      await Promise.allSettled([...pending.values()].map(settle => settle()));
    }
  });
}
