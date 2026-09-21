import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildZip } from "@/infrastructure/documents/engine/zip";
import { deckOrder, pptxToText, PptxError, slideXmlToBlocks } from "@/infrastructure/documents/engine/read/pptx";

const utf8 = (value: string) => new TextEncoder().encode(value);

const slideRelationship = (id: string, target: string, extra = "") =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${target}" ${extra}/>`;
const presentation = (...ids: string[]) =>
  `<p:presentation><p:sldIdLst>${ids.map((id) => `<p:sldId r:id="${id}"/>`).join("")}</p:sldIdLst></p:presentation>`;

function deckParts(...slides: string[]): Record<string, Uint8Array> {
  const parts: Record<string, Uint8Array> = {
    "ppt/presentation.xml": utf8(presentation(...slides.map((_, index) => `rId${index + 1}`))),
    "ppt/_rels/presentation.xml.rels": utf8(
      `<Relationships>${slides.map((_, index) => slideRelationship(`rId${index + 1}`, `slides/slide${index + 1}.xml`)).join("")}</Relationships>`,
    ),
  };
  slides.forEach((body, index) => {
    parts[`ppt/slides/slide${index + 1}.xml`] = utf8(
      `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`,
    );
  });
  return parts;
}

const deck = (...slides: string[]) => buildZip(deckParts(...slides));
const para = (...runs: string[]) => `<a:p>${runs.map((r) => `<a:r><a:t>${r}</a:t></a:r>`).join("")}</a:p>`;

test("each slide is numbered, because that is how a person addresses one", () => {
  const { text, slides } = pptxToText(deck(para("Title"), para("Second")));
  assert.equal(slides, 2);
  assert.equal(text, "## Slide 1\n\nTitle\n\n## Slide 2\n\nSecond");
});

test("runs inside a paragraph join into one line", () => {
  // A deck splits a sentence across runs whenever formatting changes mid-line.
  const { text } = pptxToText(deck(para("Revenue ", "rose ", "12%")));
  assert.equal(text, "## Slide 1\n\nRevenue rose 12%");
});

test("a soft break is the line the author put there", () => {
  const { text } = pptxToText(deck(`<a:p><a:r><a:t>one</a:t></a:r><a:br/><a:r><a:t>two</a:t></a:r></a:p>`));
  // A break ends the block, so the two lines stay two things said.
  assert.equal(text, "## Slide 1\n\none\n\ntwo");
});

test("table cells are separated the way every other reader separates them", () => {
  const row = `<a:tr><a:tc>${para("A")}</a:tc><a:tc>${para("B")}</a:tc></a:tr>`;
  const { text } = pptxToText(deck(`<a:tbl>${row}</a:tbl>`));
  assert.match(text, /\| A \| B \|/);
});

test("an empty slide keeps its number rather than vanishing", () => {
  // Otherwise "slide 3" in the text means slide 4 in the file.
  const { text } = pptxToText(deck(para("first"), "", para("third")));
  assert.match(text, /## Slide 2\n\n## Slide 3/);
});

test("a zip with no slides is not a deck, and says so", () => {
  assert.throws(() => pptxToText(buildZip({ "notes.txt": utf8("hi") })), PptxError);
});

const shape = (body: string, placeholder = "") =>
  `<p:sp><p:nvSpPr><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`;

test("a slide's title is a heading, which nothing said before", () => {
  // `p:ph/@type` is the only trustworthy title signal a deck has. Without it a
  // slide's title is indistinguishable from its body text.
  const blocks = slideXmlToBlocks(
    `<p:spTree>${shape(para("2026 계획"), '<p:ph type="title"/>')}${shape(para("본문"))}</p:spTree>`,
  );
  assert.deepEqual(blocks, [
    { kind: "heading", level: 3, runs: [{ text: "2026 계획" }] },
    { kind: "paragraph", runs: [{ text: "본문" }] },
  ]);
});

test("two text boxes are two things said, not one run-on line", () => {
  const blocks = slideXmlToBlocks(`<p:spTree>${shape(para("첫째"))}${shape(para("둘째"))}</p:spTree>`);
  assert.equal(blocks.length, 2);
});

test("emphasis in a deck is an attribute, and `b=\"0\"` is not bold", () => {
  const runs = (properties: string, text: string) =>
    `<a:p><a:r><a:rPr ${properties}/><a:t>${text}</a:t></a:r></a:p>`;
  assert.deepEqual(slideXmlToBlocks(`<p:spTree>${shape(runs('b="1"', "on"))}</p:spTree>`), [
    { kind: "paragraph", runs: [{ text: "on", bold: true }] },
  ]);
  assert.deepEqual(slideXmlToBlocks(`<p:spTree>${shape(runs('b="0"', "off"))}</p:spTree>`), [
    { kind: "paragraph", runs: [{ text: "off" }] },
  ]);
});

test("a bullet the slide turned off is not a list", () => {
  // `a:buNone` turns off a bullet the layout would have given the paragraph,
  // so an unmarked paragraph is not "no bullet" — it inherits one.
  const withPr = (pPr: string) => `<a:p>${pPr}<a:r><a:t>x</a:t></a:r></a:p>`;
  assert.equal(slideXmlToBlocks(`<p:spTree>${shape(withPr("<a:pPr><a:buNone/></a:pPr>"))}</p:spTree>`)[0]?.kind, "paragraph");
  assert.equal(
    slideXmlToBlocks(`<p:spTree>${shape(withPr('<a:pPr lvl="1"><a:buChar char="•"/></a:pPr>'))}</p:spTree>`)[0]?.kind,
    "list",
  );
});

const numbered = (text: string, attributes = "", level = 0) =>
  `<a:p><a:pPr lvl="${level}"><a:buAutoNum type="arabicPeriod" ${attributes}/></a:pPr>` +
  `<a:r><a:t>${text}</a:t></a:r></a:p>`;

test("native numbering preserves its start, continuation and explicit restart within a text body", () => {
  const body = shape(numbered("five", 'startAt="5"') + numbered("six") + numbered("three", 'startAt="3"'));
  const blocks = slideXmlToBlocks(body + shape(numbered("new shape")));
  assert.deepEqual(blocks, [
    { kind: "list", ordered: true, marks: { start: 5 }, items: [
      { runs: [{ text: "five" }], depth: 0 }, { runs: [{ text: "six" }], depth: 0 },
    ] },
    { kind: "list", ordered: true, marks: { start: 3 }, items: [{ runs: [{ text: "three" }], depth: 0 }] },
    { kind: "list", ordered: true, items: [{ runs: [{ text: "new shape" }], depth: 0 }] },
  ]);
  assert.match(pptxToText(deck(body)).text, /5\. five\n6\. six\n\n3\. three$/);
});

test("native numbering counts each level and preserves an explicit nested start", () => {
  const body = shape(numbered("parent") + numbered("child", "", 1) + numbered("next parent") +
    numbered("child seven", 'startAt="7"', 1) + numbered("child eight", "", 1));
  assert.equal(pptxToText(deck(body)).text,
    "## Slide 1\n\n1. parent\n  1. child\n2. next parent\n\n  7. child seven\n  8. child eight");
  const nestedFirst = shape(numbered("child seven", 'startAt="7"', 1) + numbered("parent") + numbered("new child", "", 1));
  assert.equal(pptxToText(deck(nestedFirst)).text,
    "## Slide 1\n\n  7. child seven\n1. parent\n  1. new child");
});

test("a link on a slide keeps its target", () => {
  const rels = '<Relationships><Relationship Id="rId2" Target="https://example.com/a"/></Relationships>';
  const body = `<a:p><a:r><a:rPr><a:hlinkClick r:id="rId2"/></a:rPr><a:t>여기</a:t></a:r></a:p>`;
  assert.deepEqual(slideXmlToBlocks(`<p:spTree>${shape(body)}</p:spTree>`, rels), [
    { kind: "paragraph", runs: [{ text: "여기", href: "https://example.com/a" }] },
  ]);
});

test("the deck's own order wins over the numbers its slides were named with", () => {
  // A deck reordered without being renamed keeps its old numbers, and reading
  // those is wrong twice — the reading order, and the "slide 7" someone looks
  // for.
  const rels =
    `<Relationships>${slideRelationship("rA", "slides/slide2.xml")}${slideRelationship("rB", "slides/slide1.xml")}</Relationships>`;
  assert.deepEqual(deckOrder(presentation("rA", "rB"), rels, ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]), [
    "ppt/slides/slide2.xml",
    "ppt/slides/slide1.xml",
  ]);
});

test("unreferenced slide parts cannot change the deck's contents or order", () => {
  const parts = deckParts(para("First"), para("Removed content"), para("Third"));
  parts["ppt/presentation.xml"] = utf8(presentation("rId3", "rId1"));
  assert.deepEqual(pptxToText(buildZip(parts)), {
    slides: 2,
    text: "## Slide 1\n\nThird\n\n## Slide 2\n\nFirst",
  });
});

test("slide references are actual XML children, including namespaced elements", () => {
  const parts = deckParts(para("Kept"), para("Not in deck"));
  parts["ppt/presentation.xml"] = utf8(
    '<x:presentation><!-- <x:sldIdLst><x:sldId r:id="missing"/></x:sldIdLst> -->' +
    '<x:sldIdLst><!-- <x:sldId r:id="rId2"/> --><x:sldId r:id="rId1"/></x:sldIdLst>' +
    '<x:extLst><x:ext><x:sldId r:id="rId2"/></x:ext></x:extLst></x:presentation>',
  );
  parts["ppt/_rels/presentation.xml.rels"] = utf8(
    '<x:Relationships><!-- <Relationship Id="rId1" Target="slides/slide2.xml"/> -->' +
    slideRelationship("rId1", "slides/slide1.xml").replace("<Relationship", "<x:Relationship") +
    '</x:Relationships>',
  );
  assert.deepEqual(pptxToText(buildZip(parts)), { slides: 1, text: "## Slide 1\n\nKept" });
});

test("declared slide relationships can name parts outside the conventional filename pattern", () => {
  const parts = deckParts(para("Custom part"));
  parts["slides/custom.xml"] = parts["ppt/slides/slide1.xml"]!;
  delete parts["ppt/slides/slide1.xml"];
  parts["ppt/_rels/presentation.xml.rels"] = utf8(
    `<Relationships>${slideRelationship("rId1", "../slides/custom.xml")}</Relationships>`,
  );
  assert.deepEqual(pptxToText(buildZip(parts)), { slides: 1, text: "## Slide 1\n\nCustom part" });
});

test("missing or ambiguous slide declarations fail instead of guessing from archive filenames", () => {
  const names = ["ppt/slides/slide1.xml"];
  const relationship = slideRelationship("rId1", "slides/slide1.xml");
  const rels = `<Relationships>${relationship}</Relationships>`;
  for (const document of ["", "<p:presentation/>", presentation(), presentation("missing")]) {
    assert.throws(() => deckOrder(document, rels, names), PptxError);
  }
  for (const links of [
    "",
    "<Relationships/>",
    `<Relationships>${relationship}${relationship}</Relationships>`,
    `<Relationships>${slideRelationship("rId1", "slides/missing.xml")}</Relationships>`,
    `<Relationships>${slideRelationship("rId1", "slides/slide1.xml", 'TargetMode="External"')}</Relationships>`,
    rels.replace("relationships/slide", "relationships/notesSlide"),
  ]) {
    assert.throws(() => deckOrder(presentation("rId1"), links, names), PptxError);
  }
  assert.throws(() => deckOrder(presentation("rId1", "rId1"), rels, names), PptxError);
  const incomplete = deckParts(para("Do not guess"));
  delete incomplete["ppt/_rels/presentation.xml.rels"];
  assert.throws(() => pptxToText(buildZip(incomplete)), PptxError);
});

test("a picture on a slide leaves a mark", () => {
  const rels = '<Relationships><Relationship Id="rId3" Target="../media/image2.png"/></Relationships>';
  const xml =
    '<p:spTree><p:pic><p:nvPicPr><p:cNvPr name="Picture 2" descr="구조도"/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic></p:spTree>';
  assert.deepEqual(slideXmlToBlocks(xml, rels), [
    { kind: "image", alt: "구조도", target: "ppt/media/image2.png" },
  ]);
});

test("a cell that spans columns says so", () => {
  const cell = (attributes: string, text: string) =>
    `<a:tc ${attributes}>${para(text)}</a:tc>`;
  const xml =
    `<p:spTree><a:tbl><a:tr>${cell('gridSpan="2"', "2026년")}${cell('hMerge="1"', "")}` +
    `${cell("", "비고")}</a:tr><a:tr>${cell("", "a")}${cell("", "b")}${cell("", "c")}</a:tr></a:tbl></p:spTree>`;
  const table = slideXmlToBlocks(xml).find((block) => block.kind === "table");
  if (table?.kind === "table") {
    assert.equal(table.columns, 3);
    assert.equal(table.rows[0]?.cells[0]?.colspan, 2);
    assert.equal(table.merged, true);
  }
});

test("explicitly disabled merge flags do not discard table cells", () => {
  for (const value of ["0", "false"]) {
    const xml = `<a:tbl><a:tr><a:tc hMerge="${value}" vMerge="${value}">${para("kept")}</a:tc>` +
      `<a:tc>${para("next")}</a:tc></a:tr></a:tbl>`;
    const table = slideXmlToBlocks(xml).find((block) => block.kind === "table");
    assert.ok(table);
    assert.equal(table.columns, 2);
    assert.deepEqual(table.rows[0]?.cells.map((cell) => cell.runs.map((run) => run.text).join("")), ["kept", "next"]);
  }
});
