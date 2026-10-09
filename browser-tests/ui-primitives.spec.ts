import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
let server: Server;
let base: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/ui-primitives.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-ui-primitives", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "auth-client", setup(build) {
      build.onResolve({ filter: /^@\/lib\/auth-client$/ }, () => ({ path: "auth", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents:
        'export const authClient = { signIn: { email: async () => ({ error: { message: "Synthetic sign-in error" } }) } }; export const signIn = {}; export const signInWithOidc = () => { throw new Error("Unexpected provider action"); };', loader: "js" }));
    } }],
  });
  server = createServer((request,response) => {
    const asset=bundle.outputFiles.find(file => request.url===`/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", asset ? asset.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html");
    response.end(asset?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui-primitives.css"><div id="root"></div><script src="/ui-primitives.js"></script>');
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
for (const locale of ["en", "ko"]) {
  test(`password visibility is named and keyboard operable in ${locale}`, async ({ page }) => {
    await page.goto(`${base}?page=sign-in&locale=${locale}`);
    const password = page.locator('input[autocomplete="current-password"]');
    await expect(password).toHaveAccessibleName(locale === "ko" ? /^비밀번호/ : /^Password/);
    await password.fill("fixture-only");
    await expect(password).toHaveAttribute("type", "password");
    await password.press("Tab");
    const toggle = page.getByRole("button", { name: locale === "ko" ? "비밀번호 표시" : "Show password", exact: true });
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Space");
    await expect(password).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: locale === "ko" ? "비밀번호 숨기기" : "Hide password", exact: true }).press("Enter");
    await expect(password).toHaveAttribute("type", "password");
    await expect(password).toHaveValue("fixture-only");
  });
  test(`selection controls support named keyboard removal in ${locale}`, async ({ page }) => {
    await page.goto(`${base}?page=pickers&locale=${locale}`);
    const remove = page.getByRole("button", { name: locale === "ko" ? "first 제거" : "Remove first", exact: true });
    const box = await remove.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);
    await page.getByText("Skills", { exact: true }).click();
    await expect(remove).toBeVisible();
    await remove.focus();
    await page.keyboard.press("Space");
    await expect(remove).toHaveCount(0);
    const picker = page.getByRole("combobox", { name: "Skills", exact: true });
    await picker.fill("third");
    await picker.press("ArrowDown");
    await picker.press("Enter");
    await expect(picker).toHaveValue("");
    await expect(page.getByRole("button", { name: locale === "ko" ? "third 제거" : "Remove third", exact: true })).toBeVisible();
  });
}
for(const scheme of ["light","dark"] as const){
  test(`semantic control text remains readable in ${scheme}`,async({page})=>{
    await page.emulateMedia({colorScheme:scheme});
    await page.goto(base);
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme",scheme);
    const measure=()=>page.locator('[data-testid], pre span').evaluateAll(elements=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d')!;
      const rgba=(color:string)=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
      const luminance=(rgb:number[])=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i]!,0);
      const blend=(fg:number[],bg:number[])=>fg.slice(0,3).map((v,i)=>v*fg[3]!/255+bg[i]!*(1-fg[3]!/255));
      return elements.map(element=>{
        const style=getComputedStyle(element);const background=rgba(style.backgroundColor);
        let parent=element.parentElement;let surface=[255,255,255,255];
        while(parent){const color=rgba(getComputedStyle(parent).backgroundColor);if(color[3]===255){surface=color;break;}parent=parent.parentElement;}
        const bg=blend(background,surface);const fg=blend(rgba(style.color),[...bg,255]);
        const first=luminance(fg),second=luminance(bg);
        return {name:element.getAttribute('data-testid') ?? element.textContent,color:style.color,background:style.backgroundColor,ratio:(Math.max(first,second)+0.05)/(Math.min(first,second)+0.05)};
      });
    });
    const samples=await measure();
    for(const sample of samples)expect.soft(sample.ratio,sample.name!).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({path:`/tmp/agent-studio-ui-primitives-${scheme}.png`,fullPage:true});
    for (const button of await page.getByRole('button').all()) {
      await button.hover();
      const name = await button.getAttribute('data-testid');
      const sample = (await measure()).find(sample => sample.name === name)!;
      expect.soft(sample.ratio, `${name} hover`).toBeGreaterThanOrEqual(4.5);
    }
  });
}
