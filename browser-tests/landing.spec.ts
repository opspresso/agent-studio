import { test, expect } from "@playwright/test";

// Opt in against a running app; the other preview tests own isolated fixtures.
const base = process.env.LANDING_BASE_URL;
test.skip(!base, "Set LANDING_BASE_URL=http://localhost:3000 to verify the public landing page.");
test.use({ locale: "en-US", colorScheme: "light", viewport: { width: 1440, height: 1000 } });

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

test("preserves the same deployment logo and name as the console", async ({ page }) => {
  const homeBrand = page.locator('header a[href="#top"]');
  const name = await homeBrand.getAttribute("aria-label");
  const logo = new URL((await homeBrand.locator("img").getAttribute("src"))!, base).searchParams.get("url");
  expect(logo).toMatch(/^\/brands\/[^/]+\/logo\.png$/);
  await page.getByRole("link", { name: "Explore the guide", exact: true }).first().click();
  const consoleBrand = page.locator('header a[href="/"]');
  await expect(consoleBrand).toHaveText(name!);
  const consoleLogo = new URL((await consoleBrand.locator("img").getAttribute("src"))!, base).searchParams.get("url");
  expect(consoleLogo).toBe(logo);
});

test("uses the existing blue palette and follows the console color scheme", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const landing = page.locator("#top");
  const light = await landing.evaluate(element => getComputedStyle(element).backgroundColor);
  const canvas = page.locator("canvas");
  const channels = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    let red = 0;
    let blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      red += pixels[i]! * pixels[i + 3]!;
      blue += pixels[i + 2]! * pixels[i + 3]!;
    }
    return { red, blue };
  });
  await expect.poll(async () => (await channels()).blue).toBeGreaterThan(0);
  const lightParticles = await channels();
  expect(lightParticles.blue).toBeGreaterThan(lightParticles.red * 1.5);
  const logo = await page.locator("header img").getAttribute("src");
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitem", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
  await expect.poll(() => landing.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(light);
  await expect(page.locator("header img")).toHaveAttribute("src", logo!);
  const darkParticles = await channels();
  expect(darkParticles.blue).toBeGreaterThan(darkParticles.red * 1.5);
  await page.screenshot({ path: testInfo.outputPath("landing-dark.png") });
  await page.getByRole("button", { name: /^Theme:/ }).click();
  await page.getByRole("menuitem", { name: "Light", exact: true }).click();
  await expect.poll(() => landing.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(light);
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

test("pauses, scrubs and resumes the workflow without background rendering", async ({ page }) => {
  const canvas = page.locator("canvas");
  const pixels = () => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause animation", exact: true }).click();
  const paused = await pixels();
  await page.waitForTimeout(150);
  expect(await pixels()).toBe(paused);
  await page.getByRole("slider", { name: "Explore the workflow" }).press("End");
  await expect.poll(pixels).not.toBe(paused);
  await expect(page.getByRole("slider", { name: "Explore the workflow" })).toHaveValue("2");
  await expect(page.getByRole("button", { name: /03.*Deliver/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Documents · Spreadsheets", { exact: true })).toBeVisible();
  await expect(page.getByText("Meeting notes · Summaries", { exact: true })).toBeVisible();
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
  await page.getByRole("slider", { name: "Explore the workflow" }).press("End");
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(still);
  await page.getByRole("link", { name: "Capabilities", exact: true }).click();
  await expect(page.locator("#capabilities")).toBeInViewport();
  await expect(page.getByRole("button", { name: /Configure and connect/ })).toBeVisible();
  await expect(page.locator("#capability-configure")).toBeVisible();
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

test("keeps English workflow controls fully readable on a narrow screen", async ({ page }) => {
  for (const width of [1024, 900, 768, 700, 650, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const hint = page.getByText("Drag to explore the flow", { exact: true });
    await hint.scrollIntoViewIfNeeded();
    for (const control of [hint, page.getByRole("slider"), page.getByRole("button", { name: /03.*Deliver/ })]) {
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    expect((await page.getByRole("slider").boundingBox())!.width).toBeGreaterThan(100);
  }
});


test("opens capabilities without moving focus or hiding unrelated content", async ({ page }) => {
  const execute = page.getByRole("button", { name: /Run work. Create outcomes./ });
  await execute.click();
  await expect(execute).toHaveAttribute("aria-expanded", "true");
  await expect(execute).toBeFocused();
  await expect(page.locator("#capability-execute")).toContainText("transcribe and summarize");
  await expect(page.locator("#capability-configure")).toBeHidden();
  await execute.press("Enter");
  await expect(execute).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#capability-execute")).toBeHidden();
  await page.getByRole("button", { name: /Understand every run/ }).click();
  await expect(page.locator("#capability-observe")).toBeVisible();
});
