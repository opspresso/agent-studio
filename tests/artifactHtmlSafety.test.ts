import { describe, expect, it } from "vitest";
import { ARTIFACT_VIEW_POLICY, INTERACTIVE_HTML_VIEW_POLICY, decodeArtifactHtml } from "@/app/api/artifacts/[artifactId]/view/_lib/htmlSafety";
import { interactiveHtml } from "@/app/api/artifacts/[artifactId]/view/_lib/interactiveHtml";
import { translator } from "@/app/_i18n/translate";

const bytes = (source: string) => new TextEncoder().encode(source);

describe("HTML artifact isolation", () => {
  it("retains interactive source only in an escaped srcdoc attribute", () => {
    const source = '<style>.step {display:none}</style><button onclick="next()">Next</button><input type="range"><canvas id="art"></canvas><script>function next(){document.body.dataset.step="2"}</script>';
    const page = interactiveHtml(bytes(source), "text/html", "report.html", translator("en"))!;
    expect(page).toContain('sandbox="allow-scripts"');
    expect(page).toContain('&lt;button onclick=&quot;next()&quot;&gt;');
    expect(page).toContain('&lt;canvas id=&quot;art&quot;&gt;');
    expect(page).not.toContain('<button onclick="next()">');
    expect(page).not.toContain('<script>function next()');
    expect(page).not.toContain('allow-same-origin');
  });

  it("cannot escape the wrapper through source or filename markup", () => {
    const attack = '"></iframe></template><script id="escaped">top.compromised=true</script><!--';
    const page = interactiveHtml(bytes(attack), "text/html", attack, translator("en"))!;
    expect(page).not.toContain('<script id="escaped">');
    expect(page.match(/<iframe /g)).toHaveLength(1);
    expect(page.match(/<script>/g)).toHaveLength(1);
    expect(page).toContain('&lt;/template&gt;');
  });

  it("keeps static views script-free and confines interactive descendants", () => {
    expect(ARTIFACT_VIEW_POLICY).not.toContain("allow-scripts");
    expect(INTERACTIVE_HTML_VIEW_POLICY).toContain("sandbox allow-scripts;");
    expect(INTERACTIVE_HTML_VIEW_POLICY).not.toMatch(/allow-same-origin|allow-popups|allow-top-navigation|allow-forms|unsafe-eval/);
    for (const rule of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
      expect(INTERACTIVE_HTML_VIEW_POLICY).toContain(rule);
    }
  });

  it("rejects invalid bytes and honors the declared charset", () => {
    expect(decodeArtifactHtml(new Uint8Array([0xff]), "text/html")).toBeNull();
    expect(interactiveHtml(new Uint8Array([0xff]), "text/html", undefined, translator("en"))).toBeNull();
    expect(decodeArtifactHtml(new Uint8Array([0xe9]), "text/html; charset=windows-1252")).toBe("é");
  });

  it.each(["en", "ko"] as const)("renders localized controls in %s", (locale) => {
    const t = translator(locale);
    const page = interactiveHtml(bytes("<p>Report</p>"), "text/html", undefined, t)!;
    expect(page).toContain(t("artifacts.preview.stop"));
    expect(page).toContain(t("artifacts.preview.restart"));
    expect(page).toContain(t("artifacts.preview.note"));
  });
});
