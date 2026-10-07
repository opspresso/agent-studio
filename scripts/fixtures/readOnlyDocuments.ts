import CFB from "cfb";
import type { DocumentFile } from "@/domain/document/processor";
import { buildZip, stored } from "@/infrastructure/documents/engine/zip";

export const READ_ONLY_DOCUMENT_EXTENSIONS = ["hwp", "odt", "ods", "odp", "rtf"] as const;

/** Shared by unit and worker checks; remains available in Docker build contexts. */
export function readOnlyDocumentFixture(extension: typeof READ_ONLY_DOCUMENT_EXTENSIONS[number]): DocumentFile {
  const text = "Original content.";
  const name = `report.${extension}`;
  if (extension === "rtf") return { name, mimeType: "text/rtf", bytes: Buffer.from(`{\\rtf1 ${text}}`) };
  if (extension === "hwp") {
    const header = Buffer.alloc(256);
    header.write("HWP Document File", "latin1");
    header[35] = 5;
    const body = Buffer.from(text, "utf16le");
    const record = Buffer.alloc(4);
    record.writeUInt32LE((0x010 + 51) | (body.length << 20));
    const container = CFB.utils.cfb_new();
    CFB.utils.cfb_add(container, "FileHeader", header);
    CFB.utils.cfb_add(container, "BodyText/Section0", Buffer.concat([record, body]));
    return { name, mimeType: "application/x-hwp", bytes: new Uint8Array(CFB.write(container, { type: "buffer" }) as Buffer) };
  }
  const mimeType = `application/vnd.oasis.opendocument.${extension === "odt" ? "text" : extension === "ods" ? "spreadsheet" : "presentation"}`;
  const paragraph = `<text:p>${text}</text:p>`;
  const body = extension === "ods"
    ? `<table:table table:name="Summary"><table:table-row><table:table-cell>${paragraph}</table:table-cell></table:table-row></table:table>`
    : extension === "odp" ? `<draw:page>${paragraph}</draw:page>` : paragraph;
  return { name, mimeType, bytes: buildZip({
    mimetype: stored(Buffer.from(mimeType)),
    "content.xml": Buffer.from(`<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body>${body}</office:body></office:document-content>`),
  }) };
}
