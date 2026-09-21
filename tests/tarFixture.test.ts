import { describe, expect, it } from "vitest";
import { readTarArchive } from "@/infrastructure/archive/tar";
import { writeTar } from "./tarFixture";

function assertPaxRecords(archive: Buffer, expected: string[], scope = "x") {
  expect(archive.toString("ascii", 156, 157)).toBe(scope);
  const bodyBytes = Number.parseInt(archive.toString("ascii", 124, 136), 8);
  const body = archive.subarray(512, 512 + bodyBytes);
  let offset = 0;
  for (const record of expected) {
    const space = body.indexOf(0x20, offset);
    expect(space).toBeGreaterThan(offset);
    const declared = Number(body.toString("ascii", offset, space));
    const encoded = `${declared} ${record}\n`;
    expect(declared).toBe(Buffer.byteLength(encoded, "utf8"));
    expect(body.subarray(offset, offset + declared).toString("utf8")).toBe(encoded);
    offset += declared;
  }
  expect(offset).toBe(bodyBytes);
}

const valueWithBytes = (bytes: number, utf8: boolean) => utf8
  ? "한".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3)
  : "x".repeat(bytes);

describe("TAR fixture PAX records", () => {
  it.each([false, true])("counts its decimal length prefix exactly at digit boundaries (UTF-8=%s)", (utf8) => {
    const records = [8, 9, 97, 98, 99, 996, 997, 998, 999].map((bodyBytes) => `k=${valueWithBytes(bodyBytes - 4, utf8)}`);
    for (const scope of ["x", "g"] as const) {
      assertPaxRecords(writeTar([{ path: "file.txt", content: "body", paxRecords: { scope, records } }]), records, scope);
    }
  });

  it.each([false, true])("writes long PAX paths across the four-digit boundary (UTF-8=%s)", async (utf8) => {
    for (const bodyBytes of [996, 997, 998, 999]) {
      const path = valueWithBytes(bodyBytes - 7, utf8);
      const archive = writeTar([{ path, content: "body", longName: "pax" }]);
      assertPaxRecords(archive, [`path=${path}`]);
      expect((await readTarArchive(archive)).map((file) => [file.path, file.bytes.toString("utf8")])).toEqual([[path, "body"]]);
    }
  });

  it.each(["gnu", "pax"] as const)("uses %s for names over 100 bytes even below 100 characters", async (longName) => {
    const path = `${"한".repeat(34)}.md`;
    expect(path.length).toBeLessThan(100);
    expect(Buffer.byteLength(path)).toBeGreaterThan(100);
    const archive = writeTar([{ path, content: "body", longName }]);
    if (longName === "pax") assertPaxRecords(archive, [`path=${path}`]);
    expect((await readTarArchive(archive)).map((file) => [file.path, file.bytes.toString("utf8")])).toEqual([[path, "body"]]);
  });
});
