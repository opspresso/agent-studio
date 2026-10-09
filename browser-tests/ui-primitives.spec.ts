import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
let server: Server;
let base: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/ui-primitives.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-ui-primitives", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
  server = createServer((request,response) => {
    const asset=bundle.outputFiles.find(file => request.url===`/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", asset ? asset.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html");
    response.end(asset?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui-primitives.css"><div id="root"></div><script src="/ui-primitives.js"></script>');
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
for(const scheme of ["light","dark"] as const){
  test(`semantic control text remains readable in ${scheme}`,async({page})=>{
    await page.emulateMedia({colorScheme:scheme});
    await page.goto(base);
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme",scheme);
    const measure=()=>page.locator('[data-testid]').evaluateAll(elements=>{
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
        return {name:element.getAttribute('data-testid'),color:style.color,background:style.backgroundColor,ratio:(Math.max(first,second)+0.05)/(Math.min(first,second)+0.05)};
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
