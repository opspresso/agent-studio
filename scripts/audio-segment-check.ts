import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAudioSegmenter } from "@/infrastructure/llm/audioSegmenter";

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "audio-fixture-"));
  try {
    const path = join(directory, "sample.mp3");
    const binary = process.env.FFMPEG_PATH ?? "ffmpeg";
    await promisify(execFile)(binary, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      "sine=frequency=440:duration=1.5", "-ar", "16000", "-ac", "1", path]);
    const bytes = await readFile(path);
    const segmenter = createAudioSegmenter({ binary, searchPath: process.env.PATH, scratchRoot: directory });
    const segments = [];
    for await (const segment of segmenter.split({ bytes, mimeType: "audio/mpeg", segmentSeconds: 0.5, maxSegmentBytes: 16_044 })) {
      segments.push(segment);
      assert.equal(Buffer.from(segment.bytes).toString("ascii", 0, 4), "RIFF");
      assert.ok(segment.bytes.length <= 16_044);
      assert.equal(segment.end - segment.start, (segment.bytes.length - 44) / 32_000);
    }
    assert.equal(segments.length, 3);
    assert.equal(segments[0]?.start, 0);
    assert.equal(segments.at(-1)?.end, 1.5);
    assert.equal(segments[1]?.start, segments[0]?.end);
    const oggPath = join(directory, "recording.ogg");
    await promisify(execFile)(binary, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      "sine=frequency=440:duration=1.5", "-c:a", "libopus", "-f", "ogg", oggPath]);
    const oggBytes = await readFile(oggPath);
    const mislabeled = [];
    for await (const segment of segmenter.split({ bytes: oggBytes, mimeType: "audio/mpeg", segmentSeconds: 0.5, maxSegmentBytes: 16_044 })) {
      mislabeled.push(segment);
      assert.equal(Buffer.from(segment.bytes).toString("ascii", 0, 4), "RIFF");
      assert.ok(segment.bytes.length <= 16_044);
    }
    assert.equal(mislabeled.length, 3, "decode Ogg/Opus even when a source mapping declares MP3");
    assert.equal(mislabeled.at(-1)?.end, 1.5);
    const playlist = segmenter.split({ bytes: new TextEncoder().encode(`ffconcat version 1.0\nfile '${path}'\n`),
      mimeType: "audio/mpeg", segmentSeconds: 1, maxSegmentBytes: 32_044 });
    await assert.rejects(playlist.next(), { name: "TranscriptionError" }, "a declared audio type must not enable playlist demuxers");
    const invalid = segmenter.split({ bytes: new TextEncoder().encode("not audio"), mimeType: "audio/mpeg",
      segmentSeconds: 1, maxSegmentBytes: 32_044 });
    await assert.rejects(invalid.next(), { name: "TranscriptionError" });
    for await (const _segment of segmenter.split({ bytes, mimeType: "audio/mpeg", segmentSeconds: 0.5, maxSegmentBytes: 16_044 })) {
      break;
    }
    assert.deepEqual((await readdir(directory)).sort(), ["recording.ogg", "sample.mp3"], "success, failure and early consumer exit remove scratch files");
    console.log("PASS audio segmentation: MP3 and mislabeled Ogg/Opus, bounded WAV segments, sample coverage and refused playlists");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Audio check failed"); process.exitCode = 1; });
