import { strict as assert } from "node:assert";
import { test } from "vitest";
import { inspectXlsx, xlsxToText } from "@/infrastructure/documents/engine/read/xlsx";
import { readEntries } from "@/infrastructure/documents/engine/zip";
import { designFor } from "@/infrastructure/documents/engine/write/theme";
import { renderXlsx } from "@/infrastructure/documents/engine/write/xlsx";

const CREATED = "2026-08-23T00:00:00.000Z";

test("a generated workbook reopens with values, explicit formulas and cached results", () => {
  const rendered = renderXlsx(
    [
      {
        name: "Summary",
        rows: [
          ["항목", "값"],
          ["매출", 40],
          ["비용", 10],
          ["이익", { formula: "B2-B3", cachedValue: 30 }],
          ["문자열", "=not a formula"],
        ],
      },
    ],
    { title: "모델", created: CREATED },
  );
  assert.equal(rendered.sheets, 1);
  assert.equal(rendered.formulas, 1);
  assert.match(xlsxToText(rendered.bytes, 90_000).text, /이익 \| 30/);
  const cells = inspectXlsx(rendered.bytes).sheets[0]!.cells;
  assert.deepEqual(cells.find((cell) => cell.address === "B4"), {
    address: "B4",
    value: "30",
    formula: "B2-B3",
  });
  assert.deepEqual(cells.find((cell) => cell.address === "B5"), {
    address: "B5",
    value: "=not a formula",
  });
});

test("invalid and duplicate sheet names are refused before a file is built", () => {
  assert.throws(
    () => renderXlsx([{ name: "bad/name", rows: [] }], { title: "t", created: CREATED }),
    /invalid name/,
  );
  assert.throws(
    () =>
      renderXlsx(
        [
          { name: "Data", rows: [] },
          { name: "data", rows: [] },
        ],
        { title: "t", created: CREATED },
      ),
    /duplicated/,
  );
});

test("rows wider than the Excel grid are refused before rendering", () => {
  assert.throws(
    () => renderXlsx([{ name: "Data", rows: [Array(16_385).fill(null)] }], { title: "t", created: CREATED }),
    /column limit/,
  );
});

test("sheet names cannot change or collide during XML serialization", () => {
  for (const name of ["\u0000", "Data\u0000", "D\u000ba\u000cta"]) {
    assert.throws(
      () => renderXlsx([{ name, rows: [] }], { title: "t", created: CREATED }),
      /invalid name/,
    );
  }
});

test("formula validation applies to the expression written to XML", () => {
  for (const formula of ["=", " =  ", "1\u0000+2"]) {
    assert.throws(
      () => renderXlsx([{ name: "Data", rows: [[{ formula }]] }], { title: "t", created: CREATED }),
      /formula/,
    );
  }
  const rendered = renderXlsx(
    [{ name: "Data", rows: [[{ formula: " = SUM(A2:A3) ", cachedValue: 3 }]] }],
    { title: "t", created: CREATED },
  );
  assert.equal(inspectXlsx(rendered.bytes).sheets[0]!.cells[0]!.formula, "SUM(A2:A3)");
});

test("the header band is the design system's, not a colour typed into this file", () => {
  // It was `FF1F4E78` — one digit off the palette entry it had been copied from,
  // and the reason a renderer states no colour of its own.
  const { headerFill, headerText } = designFor().table;
  const { bytes } = renderXlsx([{ name: "Data", rows: [["a", "b"]] }], {
    title: "표",
    created: CREATED,
  });

  const styles = new TextDecoder().decode(readEntries(bytes, ["xl/styles.xml"]).get("xl/styles.xml"));

  assert.match(styles, new RegExp(`<fgColor rgb="FF${headerFill}"/>`));
  assert.match(styles, new RegExp(`<color rgb="FF${headerText}"/>`));
});
