import { describe, expect, it } from "vitest";
import { scriptJson } from "@/app/api/mcps/oauth/callback/route";

/**
 * The one page in this app served as `text/html`, and the one place an
 * authorization server's own words are put on it.
 *
 * `abandonAuthorization` relays `error_description` verbatim once the redirect
 * is attributable — that is what attributing it is *for* — so the string in this
 * outcome belongs to whoever runs that server. The `<p>` beside this has been
 * escaped since the file was written; the `<script>` was not, so one value
 * reached two sinks with one of them defended.
 */
describe("the callback page's script payload", () => {
  it("cannot end the script element that carries it", () => {
    const out = scriptJson({ ok: false, error: "</script><img src=x onerror=alert(1)>" });

    // The literal is what lands between `<script>` and `</script>`; an HTML
    // parser scanning it must not find a closing tag.
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c");
  });

  it("escapes an HTML comment opener too", () => {
    // `<!--` inside a script switches the parser into comment state, which is a
    // second way to break out of the element without ever writing `</script>`.
    expect(scriptJson({ ok: false, error: "<!--" })).not.toContain("<!--");
  });

  it("escapes the separators a script parser reads as line terminators", () => {
    // Valid JSON leaves U+2028/2029 bare; a script parser ends the statement on
    // them, so the string literal would be unterminated.
    const out = scriptJson({ ok: false, error: `a\u2028b\u2029c` });

    expect(out).not.toContain("\u2028");
    expect(out).not.toContain("\u2029");
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
  });

  it("delivers the same message it always did", () => {
    // The escapes are a JS string-literal encoding: what the opener receives has
    // to be byte-for-byte the outcome, or this fix has changed the contract.
    const outcome = { ok: false, error: "</script>\u2028 <b>bold</b> & 'quoted'" } as const;

    const decoded = JSON.parse(JSON.parse(scriptJson(outcome)) as string) as typeof outcome;

    expect(decoded).toEqual(outcome);
  });

  it("leaves an ordinary success untouched in meaning", () => {
    const outcome = { ok: true, agent: "sample-agent", server: "notion" } as const;

    expect(JSON.parse(JSON.parse(scriptJson(outcome)) as string)).toEqual(outcome);
  });
});
