import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";
import { artifactCursor } from "@/domain/artifact/repository";
import { artifactObjectKey, artifactOwnerEmail } from "@/domain/artifact/types";
import { keys } from "@/infrastructure/db/keys";
import { RETENTION } from "@/infrastructure/db/ttl";
import type { Artifact } from "@/domain/artifact/types";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { artifactRepository } = await import("@/infrastructure/db/repositories/artifactRepository");

const NOW_ISO = "2026-08-12T00:00:00Z";
const CREATED = "2026-08-01T09:30:00.000Z";
const expiredSec = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);
const freshSec = Math.floor(Date.parse("2026-12-01T00:00:00Z") / 1000);

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: "a1",
    kind: "image",
    source: "generated",
    key: "artifacts/image/a1.png",
    mimeType: "image/png",
    byteSize: 1024,
    projectName: "poster-bot",
    versionName: "v3",
    actor: { kind: "user", id: "bruce@daangn.com" },
    createdAt: CREATED,
    ...over,
  };
}

/** An artifact as the repository stores it: under its own key and both indexes. */
function row(over: Partial<Artifact> = {}, expiresAt = freshSec): Record<string, unknown> {
  const stored = artifact(over);
  const owner = artifactOwnerEmail(stored.actor, stored.ownerEmail);
  return {
    ...stored,
    ...keys.artifact(stored.artifactId),
    entityType: "ARTIFACT",
    GSI1PK: keys.artifactProjectPartition(stored.projectName),
    GSI1SK: artifactCursor(stored),
    ...(owner
      ? { GSI2PK: keys.artifactOwnerPartition(owner), GSI2SK: artifactCursor(stored) }
      : {}),
    expiresAt,
  };
}

/** Seconds after CREATED, as an ISO timestamp — for rows that must sort apart. */
function createdPlus(seconds: number): string {
  return new Date(Date.parse(CREATED) + seconds * 1000).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
  store.rows.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("artifactObjectKey", () => {
  it("derives the key from the artifact id, so a row and its object can find each other", () => {
    // The legacy `images/<random-uuid>` layout referenced nothing: an object left
    // behind by a failed write could never be identified again.
    expect(artifactObjectKey("image", "a1", "image/png")).toBe("artifacts/image/a1.png");
  });

  it("splits by kind, because a lifecycle rule applies to a prefix", () => {
    expect(artifactObjectKey("document", "d7", "application/pdf")).toBe(
      "artifacts/document/d7.pdf",
    );
  });

  it("maps the office types the platform actually stores", () => {
    expect(
      artifactObjectKey(
        "document",
        "d1",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("artifacts/document/d1.docx");
    expect(artifactObjectKey("document", "d2", "application/vnd.hancom.hwpx")).toBe(
      "artifacts/document/d2.hwpx",
    );
  });

  it("stays addressable for a type it does not know rather than guessing one", () => {
    expect(artifactObjectKey("document", "d3", "application/x-tar")).toBe(
      "artifacts/document/d3.bin",
    );
  });

  it("reads the mime type case-insensitively", () => {
    expect(artifactObjectKey("image", "a1", "Image/PNG")).toBe("artifacts/image/a1.png");
  });

  it("stays addressable for a mime type named after an Object.prototype member", () => {
    // The type is whatever a producer declared — an MCP server's word for its
    // own bytes. A plain lookup answers "constructor" with a function, which the
    // `?? "bin"` fallback reads as a hit and interpolates into the key.
    expect(artifactObjectKey("document", "d4", "constructor")).toBe(
      "artifacts/document/d4.bin",
    );
    expect(artifactObjectKey("document", "d5", "toString")).toBe("artifacts/document/d5.bin");
  });
});

describe("artifactOwnerEmail", () => {
  it("names the email for the two actors that have one", () => {
    expect(artifactOwnerEmail({ kind: "user", id: "bruce@daangn.com" })).toBe("bruce@daangn.com");
    // A token runs on its owner's behalf, so the id is theirs.
    expect(artifactOwnerEmail({ kind: "project-token", id: "bruce@daangn.com" })).toBe(
      "bruce@daangn.com",
    );
  });

  it.each(["slack", "a2a", "webhook", "schedule"] as const)(
    "names nobody for a %s run — its id is a channel or a trigger, not a mailbox",
    (kind) => {
      expect(artifactOwnerEmail({ kind, id: "U123" })).toBeUndefined();
    },
  );

  it("names nobody when the run had no actor at all", () => {
    expect(artifactOwnerEmail(undefined)).toBeUndefined();
  });
});

describe("put", () => {
  it("indexes by project, which is the only axis every artifact has", async () => {
    await artifactRepository.put(artifact());
    expect(await store.getItem(keys.artifact("a1"))).toMatchObject({
      PK: "ARTIFACT#a1",
      SK: "META",
      entityType: "ARTIFACT",
      GSI1PK: "ARTIFACTPROJECT#poster-bot",
      GSI1SK: `${CREATED}#a1`,
    });
  });

  it("also indexes by owner when the actor names an email", async () => {
    await artifactRepository.put(artifact());
    expect(await store.getItem(keys.artifact("a1"))).toMatchObject({
      GSI2PK: "ARTIFACTOWNER#bruce@daangn.com",
      GSI2SK: `${CREATED}#a1`,
    });
  });

  it("leaves the owner index empty for a run nobody's mailbox caused", async () => {
    // Sparse rather than a placeholder: a Slack artifact is reachable through
    // its project, and a row under a fake owner would be listed for nobody.
    await artifactRepository.put(artifact({ actor: { kind: "slack", id: "U123" } }));
    const stored = await store.getItem(keys.artifact("a1"));
    expect(stored?.GSI2PK).toBeUndefined();
    expect(stored?.GSI2SK).toBeUndefined();
    // Still findable, which is the whole reason the project index is not optional.
    expect(stored?.GSI1PK).toBe("ARTIFACTPROJECT#poster-bot");
  });

  it("expires the row on the artifact retention window", async () => {
    await artifactRepository.put(artifact());
    expect((await store.getItem(keys.artifact("a1")))?.expiresAt).toBe(
      Math.floor(Date.parse(CREATED) / 1000) + RETENTION.artifactDays * 86_400,
    );
  });

  it("defaults that window to the chat window, which is already an image's lifetime", () => {
    // The deployment checklist points the bucket's lifecycle rule at
    // CHAT_RETENTION_DAYS, so a shorter window would drop a picture from its own
    // gallery while it is still visible in the conversation.
    expect(RETENTION.artifactDays).toBe(RETENTION.chatDays);
  });
});

describe("get", () => {
  it("reads a row back whole", async () => {
    store.seed([row({ filename: "report.pdf", kind: "document", prompt: "요약해줘" })]);
    const found = await artifactRepository.get("a1");
    expect(found).toMatchObject({
      artifactId: "a1",
      kind: "document",
      filename: "report.pdf",
      prompt: "요약해줘",
      actor: { kind: "user", id: "bruce@daangn.com" },
    });
  });

  it("treats an expired row as gone — the physical purge is a periodic sweep", async () => {
    store.seed([row({}, expiredSec)]);
    expect(await artifactRepository.get("a1")).toBeNull();
  });

  it("returns null for a row that is not there", async () => {
    expect(await artifactRepository.get("nope")).toBeNull();
  });
});

describe("listing", () => {
  it("lists a project's artifacts newest first, and nobody else's", async () => {
    store.seed([
      row({ artifactId: "older", createdAt: createdPlus(0) }),
      row({ artifactId: "newer", createdAt: createdPlus(60) }),
      row({ artifactId: "elsewhere", projectName: "other-bot", createdAt: createdPlus(120) }),
    ]);
    const found = await artifactRepository.listByProject("poster-bot");
    expect(found.map((a) => a.artifactId)).toEqual(["newer", "older"]);
  });

  it("lists a person's artifacts through the owner index", async () => {
    store.seed([
      row({ artifactId: "mine" }),
      row({ artifactId: "theirs", actor: { kind: "user", id: "someone@daangn.com" } }),
      // A Slack run names no mailbox, so it is in nobody's gallery — only its
      // project's listing reaches it.
      row({ artifactId: "nobodys", actor: { kind: "slack", id: "U123" } }),
    ]);
    const found = await artifactRepository.listByOwner("bruce@daangn.com");
    expect(found.map((a) => a.artifactId)).toEqual(["mine"]);
  });

  it("drops expired rows the purge has not reached", async () => {
    store.seed([row({ artifactId: "fresh" }), row({ artifactId: "old" }, expiredSec)]);
    const found = await artifactRepository.listByProject("poster-bot");
    expect(found.map((a) => a.artifactId)).toEqual(["fresh"]);
  });

  it("refills a page thinned by a kind filter instead of returning it short", async () => {
    // The store applies the limit before anything here can filter, so "images
    // only" would ask for 2 and get 1 without the refill loop.
    store.seed([
      row({ artifactId: "doc1", kind: "document", createdAt: createdPlus(120) }),
      row({ artifactId: "img1", createdAt: createdPlus(60) }),
      row({ artifactId: "img2", createdAt: createdPlus(0) }),
    ]);
    const found = await artifactRepository.listByProject("poster-bot", { limit: 2, kind: "image" });
    expect(found.map((a) => a.artifactId)).toEqual(["img1", "img2"]);
  });

  it("filters by source as well", async () => {
    store.seed([
      row({ artifactId: "gen", createdAt: createdPlus(60) }),
      row({ artifactId: "att", source: "attachment", createdAt: createdPlus(0) }),
    ]);
    const found = await artifactRepository.listByProject("poster-bot", { source: "attachment" });
    expect(found.map((a) => a.artifactId)).toEqual(["att"]);
  });

  it("stops after the page bound so a filter matching nothing is not a full scan", async () => {
    store.seed(
      Array.from({ length: 12 }, (_, i) =>
        row({ artifactId: `doc${i}`, kind: "document", createdAt: createdPlus(i) }),
      ),
    );
    const query = vi.spyOn(store, "queryItems");
    const found = await artifactRepository.listByProject("poster-bot", { limit: 1, kind: "image" });
    expect(found).toEqual([]);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("pages with the previous page's last sort key, and does not repeat that row", async () => {
    store.seed([
      row({ artifactId: "a1" }),
      row({ artifactId: "a0", createdAt: "2026-07-30T00:00:00.000Z" }),
    ]);
    const cursor = artifactCursor(artifact({ artifactId: "a1" }));
    expect(cursor).toBe(`${CREATED}#a1`);
    const found = await artifactRepository.listByProject("poster-bot", { before: cursor });
    expect(found.map((a) => a.artifactId)).toEqual(["a0"]);
  });

  it("includes the whole 'to' day rather than only its midnight", async () => {
    store.seed([
      row({ artifactId: "on-the-day", createdAt: "2026-08-12T15:00:00.000Z" }),
      row({ artifactId: "day-after", createdAt: "2026-08-13T00:00:00.000Z" }),
      row({ artifactId: "before", createdAt: "2026-07-31T23:59:59.000Z" }),
    ]);
    const found = await artifactRepository.listByProject("poster-bot", {
      from: "2026-08-01",
      to: "2026-08-12",
    });
    expect(found.map((a) => a.artifactId)).toEqual(["on-the-day"]);
  });

  it("caps the page at 100 however much a caller asks for", async () => {
    store.seed(
      Array.from({ length: 101 }, (_, i) =>
        row({ artifactId: `a${String(i).padStart(3, "0")}`, createdAt: createdPlus(i) }),
      ),
    );
    const found = await artifactRepository.listByProject("poster-bot", { limit: 5000 });
    expect(found).toHaveLength(100);
  });
});

describe("delete", () => {
  it("removes the row by its own key", async () => {
    store.seed([row({ artifactId: "a1" }), row({ artifactId: "a2" })]);
    await artifactRepository.delete("a1");
    expect(await store.getItem(keys.artifact("a1"))).toBeNull();
    expect(await store.getItem(keys.artifact("a2"))).not.toBeNull();
  });
});
