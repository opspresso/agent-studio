import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";
import { interactiveHtml } from "../src/app/api/artifacts/[artifactId]/view/_lib/interactiveHtml";
import { INTERACTIVE_HTML_VIEW_POLICY, ARTIFACT_VIEW_PERMISSIONS } from "../src/app/api/artifacts/[artifactId]/view/_lib/htmlSafety";
import { translator } from "../src/app/_i18n/translate";

let server: Server;
let base: string;
let documentSource = "";
let requests: string[] = [];

test.beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === "/parent") {
      response.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "app-secret=private; SameSite=Strict" });
      response.end('<div id="trusted">Application</div><script>localStorage.setItem("secret","private")</script><iframe id="outer" src="/view"></iframe>');
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": INTERACTIVE_HTML_VIEW_POLICY,
      "Permissions-Policy": ARTIFACT_VIEW_PERMISSIONS,
    });
    response.end(interactiveHtml(Buffer.from(documentSource), "text/html", "test.html", translator("en")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
test.beforeEach(() => { requests = []; });

test("preserves step navigation, inputs and canvas; stop and restart discard state", async ({ page }) => {
  documentSource = `<meta name="viewport" content="width=device-width, initial-scale=1">
    <style>.step {display:none}.active {display:block}</style>
    <section class="step active" id="first">First</section><section class="step" id="second">Second</section>
    <button id="next">Next</button><input aria-label="Value" type="range" min="0" max="100" step="25" value="0"><output id="value">0</output>
    <canvas width="2" height="2"></canvas><svg><circle cx="5" cy="5" r="3"/></svg>
    <script>document.querySelector('#next').onclick=()=>{document.querySelector('#first').classList.remove('active');document.querySelector('#second').classList.add('active')};
    document.querySelector('input').oninput=e=>document.querySelector('#value').textContent=e.target.value;
    const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,2,2);</script>`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/view`);
  await expect(page.locator("#stage iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Run HTML", exact: true }).click();
  const content = page.frameLocator("#stage iframe");
  await content.getByRole("button", { name: "Next" }).click();
  await expect(content.locator("#second")).toBeVisible();
  await expect(content.locator("#first")).toBeHidden();
  await content.getByRole("slider").focus();
  await content.getByRole("slider").press("ArrowRight");
  await expect(content.locator("#value")).toHaveText("25");
  expect(await content.locator("canvas").evaluate((canvas: HTMLCanvasElement) => [...canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data])).toEqual([255, 0, 0, 255]);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator("#stage iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(content.locator("#first")).toBeVisible();
  await expect(content.locator("#value")).toHaveText("0");
  expect(errors).toEqual([]);
});

test("blocks app DOM, cookies, storage, workers and web requests from an embedded preview", async ({ page }) => {
  documentSource = `<output id="checks"></output><script>
    (async()=>{const result={};
    for(const [name,fn] of Object.entries({parent:()=>parent.document.body,top:()=>top.document.getElementById('trusted'),cookie:()=>document.cookie,storage:()=>localStorage.getItem('secret')})){
      try{fn();result[name]='allowed'}catch{result[name]='blocked'}
    }
    result.worker=await new Promise(resolve=>{try{const w=new Worker(URL.createObjectURL(new Blob(['postMessage(1)'],{type:'text/javascript'})));w.onmessage=()=>{w.terminate();resolve('allowed')};w.onerror=e=>{e.preventDefault();w.terminate();resolve('blocked')}}catch{resolve('blocked')}});
    try{await fetch('${base}/fetch-leak',{method:'POST',body:'private'});result.fetch='allowed'}catch{result.fetch='blocked'}
    result.popup=window.open('${base}/popup-leak')===null?'blocked':'allowed';
    document.querySelector('#checks').textContent=JSON.stringify(result);
    })();</script>`;
  await page.goto(`${base}/parent`);
  await page.frameLocator("#outer").getByRole("button", { name: "Run HTML", exact: true }).click();
  const content = page.frameLocator("#outer").frameLocator("#stage iframe");
  await expect(content.locator("#checks")).not.toBeEmpty();
  expect(JSON.parse((await content.locator("#checks").textContent())!)).toEqual({ parent: "blocked", top: "blocked", cookie: "blocked", storage: "blocked", worker: "blocked", fetch: "blocked", popup: "blocked" });
  expect(requests).toEqual(["/parent", "/view"]);
  expect(page.context().pages()).toHaveLength(1);
  await expect(page.locator("#trusted")).toHaveText("Application");
});

for (const kind of ["self", "top", "form", "nested", "css"] as const) {
  test(`blocks ${kind} navigation or subresources`, async ({ page }) => {
    const target = `${base}/leak`;
    const actions = {
      self: `location.href='${target}'`,
      top: `top.location.href='${target}'`,
      form: `const f=document.createElement('form');f.action='${target}';document.body.append(f);f.submit()`,
      nested: `const f=document.createElement('iframe');f.src='${target}';document.body.append(f)`,
      css: `const s=document.createElement('style');s.textContent="@import url('${target}');body{background-image:url('${target}')}";document.head.append(s)`,
    };
    documentSource = `<button onclick="${actions[kind].replaceAll('"', '&quot;')}">Attempt</button>`;
    await page.goto(`${base}/view`);
    await page.getByRole("button", { name: "Run HTML", exact: true }).click();
    await page.frameLocator("#stage iframe").getByRole("button", { name: "Attempt" }).click();
    // Observe the real server, not only request events: blocked navigation must send no bytes.
    await page.waitForTimeout(250);
    expect(requests).toEqual(["/view"]);
    expect(page.url()).toBe(`${base}/view`);
  });
}

test("requires an explicit launch and accurately describes the networking boundary", async ({ page }) => {
  documentSource = '<script>document.body.textContent="executed"</script>';
  await page.goto(`${base}/view`);
  await expect(page.locator("#stage iframe")).toHaveCount(0);
  await expect(page.getByText(/not a fully offline sandbox/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Run HTML", exact: true })).toBeEnabled();
  expect(requests).toEqual(["/view"]);
});

test("reports runtime errors without accepting unrelated window messages", async ({ page }) => {
  documentSource = '<body><button onclick="throw new Error(\'private-error-data\')">Fail</button></body>';
  await page.goto(`${base}/view`);
  await page.getByRole("button", { name: "Run HTML", exact: true }).click();
  await page.evaluate(() => window.postMessage({ kind: "artifact-script-error" }, "*"));
  await expect(page.locator("#stopped")).toBeHidden();
  await page.frameLocator("#stage iframe").getByRole("button", { name: "Fail" }).click();
  await expect(page.locator("#stopped")).toContainText("script error");
  await expect(page.locator("#stopped")).not.toContainText("private-error-data");
});

test("handles document property names without executing source in the wrapper", async ({ page }) => {
  documentSource = '<form name="createElement"></form><form name="head"></form><form name="documentElement"></form><output id="ok">waiting</output><script>document.getElementById("ok").textContent="ready"</script>';
  await page.goto(`${base}/view`);
  await page.getByRole("button", { name: "Run HTML", exact: true }).click();
  await expect(page.frameLocator("#stage iframe").locator("#ok")).toHaveText("ready");
});

test("keeps fragment links inside the document without navigating the frame", async ({ page }) => {
  documentSource = '<a href="#details">Jump to details</a><div style="height:1600px"></div><h2 id="details">Details</h2>';
  await page.goto(`${base}/view`);
  await page.getByRole("button", { name: "Run HTML", exact: true }).click();
  const content = page.frameLocator("#stage iframe");
  await content.getByRole("link", { name: "Jump to details" }).click();
  await expect(content.locator("#details")).toBeInViewport();
  expect(requests).toEqual(["/view"]);
});

test("renders local SVG symbol references", async ({ page }) => {
  documentSource = '<svg width="100" height="100"><defs><g id="shape"><rect width="40" height="30" fill="red"/></g></defs><use href="#shape"/></svg>';
  await page.goto(`${base}/view`);
  await page.getByRole("button", { name: "Run HTML", exact: true }).click();
  const use = page.frameLocator("#stage iframe").locator("use");
  await expect.poll(() => use.evaluate((element: SVGGraphicsElement) => element.getBBox().width)).toBe(40);
  expect(requests).toEqual(["/view"]);
});

test("updates the fixed error notice only once per execution", async ({ page }) => {
  documentSource = '<button onclick="for(let i=0;i<50;i++)parent.postMessage({kind:\'artifact-script-error\'},\'*\');parent.postMessage({kind:\'batch-finished\'},\'*\')">Report errors</button>';
  await page.goto(`${base}/view`);
  await page.getByRole("button", { name: "Run HTML", exact: true }).click();
  const notices = page.evaluate(() => new Promise<number>((resolve) => {
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(document.querySelector("#stopped")!, { childList: true });
    window.addEventListener("message", function finish(event) {
      if (event.data?.kind !== "batch-finished") return;
      observer.disconnect();
      window.removeEventListener("message", finish);
      resolve(mutations);
    });
  }));
  await page.frameLocator("#stage iframe").getByRole("button", { name: "Report errors" }).click();
  expect(await notices).toBe(1);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.locator("#stopped")).toBeHidden();
  await page.frameLocator("#stage iframe").getByRole("button", { name: "Report errors" }).click();
  await expect(page.locator("#stopped")).toContainText("script error");
});


test("preserves custom fragment handlers and Unicode targets", async ({ page }) => {
  documentSource = '<a href="#missing" onclick="event.preventDefault();document.querySelector(\'#custom\').textContent=\'handled\'">Custom</a><output id="custom"></output><a href="#설명">Details</a><div style="height:1600px"></div><h2 id="설명">Target</h2>';
  await page.goto(`${base}/view`);
  await page.getByRole("button", { name: "Run HTML", exact: true }).click();
  const content = page.frameLocator("#stage iframe");
  await content.getByRole("link", { name: "Custom", exact: true }).click();
  await expect(content.locator("#custom")).toHaveText("handled");
  await content.getByRole("link", { name: "Details", exact: true }).click();
  await expect(content.locator("#설명")).toBeInViewport();
  expect(requests).toEqual(["/view"]);
});


test("honors window-level custom fragment navigation", async ({ page }) => {
  documentSource = '<a href="#unused">Custom link</a><output id="result"></output><script>addEventListener("click",event=>{event.preventDefault();document.getElementById("result").textContent="handled"})</script>';
  await page.goto(`${base}/view`);
  await page.getByRole("button", { name: "Run HTML", exact: true }).click();
  const content = page.frameLocator("#stage iframe");
  await content.getByRole("link", { name: "Custom link" }).click();
  await expect(content.locator("#result")).toHaveText("handled");
  expect(await content.locator("body").evaluate(() => location.hash)).toBe("");
});

test("rejects an external base URL after allowing the local srcdoc base", async ({ page }) => {
  documentSource = '<output id="base"></output><script>document.querySelector("base").href="https://attacker.example/";document.getElementById("base").textContent=document.baseURI</script>';
  await page.goto(`${base}/view`);
  await page.getByRole("button", { name: "Run HTML", exact: true }).click();
  const content = page.frameLocator("#stage iframe");
  await expect(content.locator("#base")).not.toBeEmpty();
  await expect(content.locator("#base")).not.toContainText("attacker.example");
  expect(requests).toEqual(["/view"]);
});
