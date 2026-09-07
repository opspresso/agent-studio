import { strict as assert } from "node:assert";
import { DOCUMENT_FORMATS } from "../src/domain/document/processor";
import { DocumentWorkerPool } from "../src/infrastructure/documents/workerPool";

async function main() {
  const pool = new DocumentWorkerPool();
  for (const format of DOCUMENT_FORMATS) {
    const output = await pool.execute("create", {
      format, title: "분기 보고서", created: "2026-09-07T00:00:00.000Z",
      ...(format === "xlsx" ? { sheets: [{ name: "Summary", rows: [["매출 증가"]] }] } : { content: "# 분기 보고서\n\n매출 증가" }),
    });
    assert.ok(output.bytes instanceof Uint8Array);
    const file = { bytes: output.bytes, mimeType: output.mimeType, name: `report.${format}` };
    const read = await pool.execute("extract", { ...file, maxChars: 20_000 });
    assert.ok(read.text.includes("매출 증가"), format);
    if (format === "docx") {
      const inspected = await pool.execute("inspect", { file });
      const target = inspected.targets.find(({ text }) => text === "매출 증가");
      assert.ok(target);
      const edited = await pool.execute("edit", { file, operations: [{ ...target, operation: "replace_text", replacement: "매출 개선" }] });
      const reread = await pool.execute("extract", { bytes: edited.bytes, mimeType: edited.mimeType, name: file.name, maxChars: 20_000 });
      assert.ok(reread.text.includes("매출 개선"));
    }
    process.stdout.write(`${format}: create, reopen${format === "docx" ? ", inspect, edit" : ""} passed\n`);
  }
}
main().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
