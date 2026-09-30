import { test, expect } from "@playwright/test";

// Opt in against a running app; the other preview tests own isolated fixtures.
const base = process.env.LANDING_BASE_URL;
test.skip(!base, "Set LANDING_BASE_URL=http://localhost:3000 to verify the public landing page.");
test.use({ locale: "en-US", viewport: { width: 1440, height: 1000 } });

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base!);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
test.afterEach(() => { expect(errors).toEqual([]); });

test("opens deployment-local login and guide from the public home", async ({ page }) => {
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Agents", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Enter the platform", exact: true }).first().click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto(base!);
  await page.getByRole("link", { name: "Explore the guide", exact: true }).first().click();
  await expect(page).toHaveURL(/\/guide$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("changes workflow examples with click and keyboard navigation", async ({ page }) => {
  await page.getByRole("tab", { name: "Meeting notes" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel).toHaveCount(1);
  await expect(panel).toContainText("Summarize this meeting recording");
  await expect(panel).toContainText("Action items.xlsx");
  await page.getByRole("tab", { name: "Meeting notes" }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Infrastructure" })).toBeFocused();
  await expect(panel).toContainText("Analyze these incident logs");
  await page.getByRole("tab", { name: "Infrastructure" }).press("End");
  await expect(panel).toContainText("Request approval");
  await page.getByRole("tab", { name: "Development", exact: true }).press("Home");
  await expect(panel).toContainText("Report.docx");
  await expect(page.getByRole("tab", { name: "Document work" })).toHaveAttribute("aria-selected", "true");
});

test("pauses, transforms and resumes the particle scene without background rendering", async ({ page }) => {
  const canvas = page.locator("canvas");
  const pixels = () => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause animation", exact: true }).click();
  const paused = await pixels();
  await page.waitForTimeout(150);
  expect(await pixels()).toBe(paused);
  await page.getByRole("button", { name: "Expand particles" }).click();
  await expect.poll(pixels).not.toBe(paused);
  await expect(page.getByRole("button", { name: "Gather particles" })).toHaveAttribute("aria-pressed", "true");
  const expanded = await pixels();
  await page.getByRole("button", { name: "Play animation" }).click();
  await expect.poll(pixels).not.toBe(expanded);
  await page.getByRole("link", { name: "Deployment", exact: true }).click();
  await expect(page.locator("#deployment")).toBeInViewport();
  // Allow the intersection notification to settle before observing idle pixels.
  await page.waitForTimeout(100);
  const offscreen = await pixels();
  await page.waitForTimeout(150);
  expect(await pixels()).toBe(offscreen);
});

test("honors reduced motion while keeping particle controls and content usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByText("Reduced motion enabled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause animation", exact: true })).toBeDisabled();
  const canvas = page.locator("canvas");
  const still = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await page.waitForTimeout(150);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).toBe(still);
  await page.getByRole("button", { name: "Expand particles" }).click();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(still);
  await page.getByRole("link", { name: "Capabilities", exact: true }).click();
  await expect(page.locator("#capabilities")).toBeInViewport();
  for (const section of await page.locator("[data-reveal]").all()) {
    await expect(section).toHaveCSS("opacity", "1");
  }
});

test("switches locale and supports narrow navigation without horizontal overflow", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Change language" }).click();
  await page.getByRole("menuitem", { name: "한국어" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("우리 회사의 AI");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.screenshot({ path: testInfo.outputPath("landing-desktop.png") });
  await page.screenshot({ path: testInfo.outputPath("landing-full.png"), fullPage: true });
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const menu = page.locator('button[aria-controls="landing-navigation"]');
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("navigation", { name: "내비게이션 열기" }).getByRole("link", { name: "활용 사례" }).click();
    await expect(page.locator("#use-cases")).toBeInViewport();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
    await page.getByRole("link", { name: "맨 위로" }).click();
    await page.screenshot({ path: testInfo.outputPath(`landing-${width}.png`) });
  }
});

test("keeps English particle controls fully readable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const hint = page.getByText("Move your cursor. See the connections.", { exact: true });
  await hint.scrollIntoViewIfNeeded();
  const bounds = await hint.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
});
