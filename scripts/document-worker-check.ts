import { strict as assert } from "node:assert";
import { DOCUMENT_FORMATS } from "../src/domain/document/processor";
import { DocumentWorkerPool } from "../src/infrastructure/documents/workerPool";
import { READ_ONLY_DOCUMENT_EXTENSIONS, readOnlyDocumentFixture } from "../tests/readOnlyDocumentFixtures";

async function main() {
  const pool = new DocumentWorkerPool();
  for (const format of DOCUMENT_FORMATS) {
    const output = await pool.execute("create", {
      format, title: "분기 보고서", created: "2026-09-07T00:00:00.000Z",
      theme: "ocean", colors: { brand: "224466" },
      ...(format === "xlsx" ? { sheets: [{ name: "Summary", rows: [["매출 증가"]] }] } : { content: "# 분기 보고서\n\n매출 증가" }),
    });
    assert.ok(output.bytes instanceof Uint8Array);
    assert.equal(output.style?.theme, "ocean");
    assert.equal(output.style?.colors.brand, "224466");
    assert.equal(output.style?.profile, format === "xlsx" ? null : "standard");
    const file = { bytes: output.bytes, mimeType: output.mimeType, name: `report.${format}` };
    const read = await pool.execute("extract", { ...file, maxChars: 20_000 });
    assert.ok(read.text.includes("매출 증가"), format);
    if (format === "pdf") {
      await assert.rejects(pool.execute("inspect", { file, options: { mode: "structure" } }), /PDF.*operation=read/);
      await assert.rejects(pool.execute("edit", { file, operations: [{ operation: "replace_text", part: "text", index: 0, text: "매출 증가", replacement: "매출 개선" }] }), /PDF.*operation=read/);
    } else {
      const structure = await pool.execute("inspect", { file, options: { mode: "structure" } });
      assert.ok(structure.text.includes("매출 증가"));
      const inspected = await pool.execute("inspect", { file });
      const target = inspected.targets.find(({ text }) => text === "매출 증가");
      assert.ok(format === "xlsx" || target);
      const edited = await pool.execute("edit", { file, operations: format === "xlsx"
        ? [{ operation: "set_cell", sheet: "Summary", cell: "A1", value: "매출 개선" }]
        : [{ ...target!, operation: "replace_text", replacement: "매출 개선" }] });
      const reread = await pool.execute("extract", { bytes: edited.bytes, mimeType: edited.mimeType, name: file.name, maxChars: 20_000 });
      assert.ok(reread.text.includes("매출 개선"));
    }
    process.stdout.write(`${format}: create, reopen, ${format === "pdf" ? "unsupported operation guidance" : "inspect, edit"} passed\n`);
  }
  for (const extension of READ_ONLY_DOCUMENT_EXTENSIONS) {
    const file = readOnlyDocumentFixture(extension);
    const read = await pool.execute("extract", { ...file, maxChars: 20_000 });
    assert.ok(read.text.includes("Original content."));
    const inspected = await pool.execute("inspect", { file, options: { mode: "structure" } });
    assert.ok(inspected.text.includes("Original content."));
    await assert.rejects(pool.execute("inspect", { file, options: { mode: "edit_targets" } }), /read-only.*mode=structure/);
    await assert.rejects(pool.execute("edit", { file, operations: [{ operation: "replace_text", part: "text", index: 0, text: "Original content.", replacement: "Edited content." }] }), /read-only.*mode=structure/);
    process.stdout.write(`${extension}: read, inspect, unsupported operation guidance passed\n`);
  }
}
main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
