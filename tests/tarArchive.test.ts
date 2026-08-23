import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  readTarArchive,
  stripLeadingDirectory,
  TarArchiveError,
  type TarFile,
} from "@/infrastructure/archive/tar";
import { tarHeader, writeTar, writeTarGz } from "./tarFixture";

const text = (files: TarFile[]) =>
  files.map((file) => [file.path, file.symlink ? "<symlink>" : file.bytes.toString("utf8")]);

describe("readTarArchive", () => {
  it("reads a gzip-compressed archive and a plain one alike", async () => {
    const entries = [
      { path: "plugins/", type: "dir" as const },
      { path: "plugins/devops/plugin.json", content: '{"name":"devops"}' },
      { path: "README.md", content: "# plugins" },
    ];
    const expected = [
      ["plugins/devops/plugin.json", '{"name":"devops"}'],
      ["README.md", "# plugins"],
    ];
    expect(text(await readTarArchive(writeTarGz(entries)))).toEqual(expected);
    expect(text(await readTarArchive(writeTar(entries)))).toEqual(expected);
  });

  it("carries a name over 100 bytes from a GNU long-name entry or a pax path record", async () => {
    const deep = `plugins/${"d".repeat(60)}/skills/${"s".repeat(40)}/SKILL.md`;
    expect(deep.length).toBeGreaterThan(100);
    for (const longName of ["gnu", "pax"] as const) {
      const files = await readTarArchive(writeTar([{ path: deep, content: "doc", longName }]));
      expect(text(files)).toEqual([[deep, "doc"]]);
    }
  });

  it("strips a leading `./` and yields a symlink by name only", async () => {
    const files = await readTarArchive(
      writeTar([
        { path: "./", type: "dir" },
        { path: "./plugin.json", content: "{}" },
        { path: "./skills/x/link.md", type: "symlink" },
        { path: "./skills/x/hard.md", type: "hardlink" },
      ]),
    );
    expect(text(files)).toEqual([
      ["plugin.json", "{}"],
      ["skills/x/link.md", "<symlink>"],
    ]);
  });

  it("refuses a path that could leave the tree, naming it", async () => {
    await expect(readTarArchive(writeTar([{ path: "../outside.md", content: "x" }]))).rejects.toThrow(
      /refusing archive entry "\.\.\/outside\.md": path is traversal/,
    );
    await expect(readTarArchive(writeTar([{ path: "/etc/passwd", content: "x" }]))).rejects.toThrow(
      /path is absolute/,
    );
    await expect(readTarArchive(writeTar([{ path: "a/../../b.md", content: "x" }]))).rejects.toThrow(
      TarArchiveError,
    );
  });

  it("stops inflating at the byte cap rather than measuring afterwards", async () => {
    const big = writeTarGz([{ path: "big.md", content: "a".repeat(4096) }]);
    await expect(readTarArchive(big, { maxBytes: 2048, maxEntries: 100 })).rejects.toThrow(
      /exceeds 2048 bytes uncompressed/,
    );
    const plain = writeTar([{ path: "big.md", content: "a".repeat(4096) }]);
    await expect(readTarArchive(plain, { maxBytes: 2048, maxEntries: 100 })).rejects.toThrow(
      /exceeds 2048 bytes/,
    );
  });

  it("bounds the entry count", async () => {
    const many = writeTar(Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.md`, content: "x" })));
    await expect(readTarArchive(many, { maxBytes: 1 << 20, maxEntries: 4 })).rejects.toThrow(
      /more than 4 entries/,
    );
  });

  it("says what it was handed when the bytes are not a tar archive", async () => {
    await expect(readTarArchive(Buffer.from("not an archive at all"))).rejects.toThrow(
      /not a tar archive/,
    );
    await expect(readTarArchive(Buffer.alloc(600, 0x41))).rejects.toThrow(/not a tar archive/);
    await expect(readTarArchive(gzipSync(Buffer.alloc(600, 0x41)))).rejects.toThrow(
      /not a tar archive/,
    );
    await expect(readTarArchive(Buffer.from([0x1f, 0x8b, 0x00, 0x00]))).rejects.toThrow(
      /not a valid gzip stream/,
    );
  });

  it("rejects a header whose checksum does not match, and a truncated entry", async () => {
    const valid = writeTar([{ path: "a.md", content: "aaa" }, { path: "b.md", content: "bbb" }]);
    const corrupt = Buffer.from(valid);
    const inSecondName = 512 + 512 + 5;
    corrupt[inSecondName] = (corrupt[inSecondName] ?? 0) ^ 0xff;
    await expect(readTarArchive(corrupt)).rejects.toThrow(/corrupt tar header at byte 1024/);

    const truncated = Buffer.concat([tarHeader("a.md", 4000, "0"), Buffer.alloc(512)]);
    await expect(readTarArchive(truncated)).rejects.toThrow(/truncated archive/);
  });
});

describe("stripLeadingDirectory", () => {
  const file = (path: string): TarFile => ({ path, bytes: Buffer.alloc(0), symlink: false });

  it("drops the one directory every path sits under, as `git archive --prefix` writes", async () => {
    const { files, prefix } = stripLeadingDirectory([
      file("agent-plugins-main/plugin.json"),
      file("agent-plugins-main/skills/x/SKILL.md"),
    ]);
    expect(prefix).toBe("agent-plugins-main");
    expect(files.map((f) => f.path)).toEqual(["plugin.json", "skills/x/SKILL.md"]);
  });

  it("leaves a tree alone when a file sits at the top level", async () => {
    const { files, prefix } = stripLeadingDirectory([
      file("plugins/devops/plugin.json"),
      file("README.md"),
    ]);
    expect(prefix).toBeNull();
    expect(files.map((f) => f.path)).toEqual(["plugins/devops/plugin.json", "README.md"]);
  });

  it("leaves a tree alone when its paths start under different directories", async () => {
    const { prefix } = stripLeadingDirectory([file("a/x.md"), file("b/y.md")]);
    expect(prefix).toBeNull();
  });

  it("reads a pax `size` record as the file's length, not the next header block's", async () => {
    // pax records ahead of a GNU long-name block: the `size` record belongs to
    // the *file*, and reading it as the long-name block's length made the
    // reader consume two blocks where the name occupies one and land mid-data.
    const longPath = `plugins/${"n".repeat(120)}.md`;
    const content = "x".repeat(600);
    const files = await readTarArchive(
      writeTar([
        {
          path: longPath,
          content,
          longName: "gnu",
          paxRecords: { scope: "x", records: [`size=${content.length}`] },
        },
      ]),
    );
    expect(files.map((file) => [file.path, file.bytes.byteLength])).toEqual([
      [longPath, content.length],
    ]);
  });
});
