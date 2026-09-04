import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "blockquote",
  "body",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "u",
  "ul",
  "var",
] as const;

const ALLOWED_ATTRIBUTES = {
  "*": ["aria-*", "class", "dir", "id", "lang", "role", "title"],
  a: ["href", "rel"],
  blockquote: ["cite"],
  col: ["span"],
  colgroup: ["span"],
  del: ["cite", "datetime"],
  details: ["open"],
  img: ["alt", "height", "loading", "src", "width"],
  ins: ["cite", "datetime"],
  li: ["value"],
  ol: ["reversed", "start", "type"],
  q: ["cite"],
  td: ["colspan", "headers", "rowspan"],
  th: ["abbr", "colspan", "headers", "rowspan", "scope"],
  time: ["datetime"],
};

/**
 * The one policy for every artifact page the app serves.
 *
 * HTML is sanitized before it reaches this policy. The sandbox remains the
 * browser-enforced backstop: no script, form, popup, download or same-origin
 * access is granted, and no subresource may leave the document.
 */
export const ARTIFACT_VIEW_POLICY = [
  "sandbox",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/**
 * Turn untrusted HTML into a static report.
 *
 * The allowlist keeps document structure and data images, but deliberately has
 * no script, style, metadata, form, embedded browsing context, SVG or MathML.
 * Event handlers and every unlisted attribute disappear with them. Links keep
 * only safe schemes and never send this page as their referrer.
 */
export function sanitizeArtifactHtml(bytes: Uint8Array, mimeType: string): string | null {
  const charset = /;\s*charset\s*=\s*"?([A-Za-z0-9._-]+)"?/i.exec(mimeType)?.[1] ?? "utf-8";
  let source: string;
  try {
    source = new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  const sanitized = sanitizeHtml(source, {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: "noreferrer" },
      }),
    },
  });
  return `<!doctype html>${sanitized}`;
}
