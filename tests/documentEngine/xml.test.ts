/**
 * The walker both office readers are built on. Every case here is a way for
 * markup to end up in the output as prose, which is the failure that looks like
 * success: the model reads it, cannot tell it apart from the document, and
 * neither can anyone reviewing the result.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  attributeOf,
  attributesOf,
  decodeXmlEntities,
  escapeXml,
  localName,
  walkXml,
  XmlError,
  type XmlHandler,
} from "@/infrastructure/documents/engine/xml";

interface Event {
  kind: "text" | "open" | "close";
  name?: string;
  value?: string;
  selfClosing?: boolean;
}

function record(xml: string): Event[] {
  const events: Event[] = [];
  const handler: XmlHandler = {
    text: (value) => events.push({ kind: "text", value }),
    open: (name, _attributes, selfClosing) => events.push({ kind: "open", name, selfClosing }),
    close: (name) => events.push({ kind: "close", name }),
  };
  walkXml(xml, handler);
  return events;
}

function textOf(xml: string): string {
  return record(xml)
    .filter((event) => event.kind === "text")
    .map((event) => event.value)
    .join("");
}

test("opens, closes and the characters between them are reported in order", () => {
  assert.deepEqual(record("<a><b>hi</b></a>"), [
    { kind: "open", name: "a", selfClosing: false },
    { kind: "open", name: "b", selfClosing: false },
    { kind: "text", value: "hi" },
    { kind: "close", name: "b" },
    { kind: "close", name: "a" },
  ]);
});

test("a self-closing tag opens and never closes", () => {
  assert.deepEqual(record("<w:tab/>"), [{ kind: "open", name: "w:tab", selfClosing: true }]);
  assert.deepEqual(record("<w:br />"), [{ kind: "open", name: "w:br", selfClosing: true }]);
});

test("attributes are separated from the name", () => {
  const seen: string[] = [];
  walkXml('<w:pStyle w:val="Heading1"/>', {
    text: () => {},
    open: (name, attributes) => seen.push(`${name}|${attributes}`),
    close: () => {},
  });
  assert.deepEqual(seen, ['w:pStyle|w:val="Heading1"']);
});

test("a `>` inside an attribute value does not cut the tag short", () => {
  // The regression this exists for: `<[^>]*>` ends the tag at the quoted `>`,
  // and everything after it — the rest of the attributes, and the tag's own
  // closing bracket — is then reported as the document's prose.
  assert.equal(textOf('<a title="1 > 0">body</a>'), "body");
});

test("declarations and comments contribute nothing", () => {
  assert.equal(textOf('<?xml version="1.0" encoding="UTF-8"?><a>x</a>'), "x");
  assert.equal(textOf("<a>x<!-- a comment -->y</a>"), "xy");
});

test("DTD and entity declarations are refused", () => {
  assert.throws(() => textOf("<!DOCTYPE html><a>x</a>"), XmlError);
  assert.throws(() => textOf('<!ENTITY x "secret"><a>&x;</a>'), XmlError);
});

test("CDATA is text, and an unterminated one takes the rest of the document literally", () => {
  assert.equal(textOf("<a><![CDATA[<b>not a tag</b>]]></a>"), "<b>not a tag</b>");
  assert.equal(textOf("<a><![CDATA[tail"), "tail");
});

test("a document cut mid-tag loses the tag rather than turning it into prose", () => {
  assert.equal(textOf("<a>kept</a><b attr=\"un"), "kept");
});

test("entities are decoded, and an escaped ampersand does not introduce a second one", () => {
  assert.equal(decodeXmlEntities("a &lt; b &amp;&amp; c"), "a < b && c");
  assert.equal(decodeXmlEntities("&amp;lt;"), "&lt;");
  assert.equal(decodeXmlEntities("&#54620;&#xAE00;"), "한글");
  // Not an entity this knows: left alone rather than eaten, so the text still
  // says what the document said.
  assert.equal(decodeXmlEntities("&unknown;"), "&unknown;");
});

test("a numeric reference that cannot be a character is dropped, not made U+FFFD", () => {
  assert.equal(decodeXmlEntities("a&#xD800;b"), "ab");
  assert.equal(decodeXmlEntities("a&#1114112;b"), "ab");
});

test("escaping round-trips through decoding", () => {
  const raw = `<a href="x">&'한글'</a>`;
  assert.equal(decodeXmlEntities(escapeXml(raw)), raw);
});

test("numeric ampersands do not decode the text they introduce again", () => {
  assert.equal(decodeXmlEntities("&#38;lt; &#x26;#65; &#x26;amp;"), "&lt; &#65; &amp;");
  assert.equal(attributeOf('name="&#38;lt;"', "name"), "&lt;");
});

test("unknown entity names cannot resolve inherited object properties", () => {
  assert.equal(decodeXmlEntities("&constructor;"), "&constructor;");
});

test("attribute-like text inside another value is not an attribute", () => {
  const attributes = `descr='example name="wrong"' name="right"`;
  assert.equal(attributeOf(attributes, "name"), "right");
  assert.equal(attributeOf(`descr='example name="wrong"'`, "name"), undefined);
});

test("a prefix is stripped, and a name without one is left alone", () => {
  assert.equal(localName("table:table-cell"), "table-cell");
  assert.equal(localName("p"), "p");
  // Only the first colon: a local name may not contain one, so anything after
  // the second belongs to the name rather than to a second prefix.
  assert.equal(localName("a:b:c"), "b:c");
});

test("an attribute is found however the writer quoted it", () => {
  // XML allows both, `endOfTag` already tracks both, and the three readers that
  // carried a copy of this matched only double quotes — so a single-quoted
  // value read as an absent one, which is "no heading", "no colspan", "no link".
  assert.equal(attributeOf('w:val="Heading1"', "w:val"), "Heading1");
  assert.equal(attributeOf("w:val='Heading1'", "w:val"), "Heading1");
  assert.equal(attributeOf('w:val="x"', "w:other"), undefined);
});

test("an attribute value is decoded, because targets and names carry ampersands", () => {
  assert.equal(attributeOf('name="A&amp;B"', "name"), "A&B");
  assert.equal(attributeOf('Target="q?a=1&amp;b=2"', "Target"), "q?a=1&b=2");
  assert.equal(attributeOf('descr="&#54620;&#xAE00;"', "descr"), "한글");
});

test("an attribute name is matched whole, not as the start of a longer one", () => {
  assert.equal(attributeOf('text:continue-numbering="true"', "text:c"), undefined);
  assert.equal(attributeOf('xtext:c="1"', "text:c"), undefined);
  assert.equal(attributeOf('text:c="4"', "text:c"), "4");
});

test("every attribute at once, first value wins", () => {
  const found = attributesOf(`a="1" b='2' c="&amp;" a="3"`);
  assert.deepEqual([...found], [
    ["a", "1"],
    ["b", "2"],
    ["c", "&"],
  ]);
});
