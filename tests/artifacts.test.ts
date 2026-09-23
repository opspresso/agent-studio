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

describe("private artifact persistence", () => {
  it("round-trips the private file address and excludes it once source retention expires", async () => {
    const stored = artifact({ kind: "audio", privateFileId: "source-id", retireAt: "2026-08-13T00:00:00.000Z" });
    store.seed([{ ...keys.project(stored.projectName), entityType: "PROJECT" },
      { ...keys.sourceFile("source-id"), file: { status: "ready", projectName: stored.projectName,
        userEmail: "bruce@daangn.com", retireAt: stored.retireAt } }]);
    await artifactRepository.put(stored);
    expect(await artifactRepository.get(stored.artifactId)).toEqual(stored);
    expect((await artifactRepository.listByOwner("bruce@daangn.com"))[0]?.privateFileId).toBe("source-id");
    vi.setSystemTime(new Date(stored.retireAt!));
    expect(await artifactRepository.get(stored.artifactId)).toBeNull();
    expect(await artifactRepository.listByOwner("bruce@daangn.com")).toEqual([]);
  });
  it.each(["pending", "deleting", "deleted"])("does not publish a stale private artifact after its file becomes %s", async (status) => {
    const stored = artifact({ kind: "audio", privateFileId: "source-id", retireAt: "2026-08-13T00:00:00.000Z" });
    store.seed([{ ...keys.project(stored.projectName), entityType: "PROJECT" },
      { ...keys.sourceFile("source-id"), file: { status, projectName: stored.projectName,
        userEmail: "bruce@daangn.com", retireAt: stored.retireAt } }]);
    await expect(artifactRepository.put(stored)).rejects.toThrow();
    expect(await artifactRepository.get(stored.artifactId)).toBeNull();
  });
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

  it.each(["slack", "webhook", "schedule"] as const)(
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

  it("fills a page a kind filter would thin, because the store filters first", async () => {
    // The limit counts matches, not rows: "images only" asked for 2 and got 1
    // when the filter ran over what had already come back.
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

  it("answers a filter that matches nothing in one read, not a walk of the partition", async () => {
    store.seed(
      Array.from({ length: 12 }, (_, i) =>
        row({ artifactId: `doc${i}`, kind: "document", createdAt: createdPlus(i) }),
      ),
    );
    const query = vi.spyOn(store, "queryItems");
    const found = await artifactRepository.listByProject("poster-bot", { limit: 1, kind: "image" });
    expect(found).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("reaches matches that lie past a page of non-matches", async () => {
    // The refill loop this replaced pulled at most five pages and then gave
    // up, and giving up looked exactly like reaching the end: an empty
    // gallery with no cursor to page past. A project holding a few hundred
    // images and a handful of older documents is the ordinary shape of it.
    store.seed([
      ...Array.from({ length: 600 }, (_, i) =>
        row({ artifactId: `img${String(i).padStart(3, "0")}`, createdAt: createdPlus(100 + i) }),
      ),
      row({ artifactId: "doc-old", kind: "document", createdAt: createdPlus(0) }),
    ]);
    const found = await artifactRepository.listByProject("poster-bot", {
      limit: 24,
      kind: "document",
    });
    expect(found.map((a) => a.artifactId)).toEqual(["doc-old"]);
  });

  it("keeps a source filter exact alongside a kind one", async () => {
    store.seed([
      row({ artifactId: "gen-img", createdAt: createdPlus(90) }),
      row({ artifactId: "att-img", source: "attachment", createdAt: createdPlus(60) }),
      row({
        artifactId: "att-doc",
        kind: "document",
        source: "attachment",
        createdAt: createdPlus(30),
      }),
    ]);
    const found = await artifactRepository.listByProject("poster-bot", {
      kind: "image",
      source: "attachment",
    });
    expect(found.map((a) => a.artifactId)).toEqual(["att-img"]);
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

describe("the store filter the listing rides on", () => {
  // Asserted against the fake because the listing rides on it; the integration
  // check pins the same three answers against real SQL.
  it("renders a stored value as text, the way `->>` does", async () => {
    store.seed([
      { PK: "F#1", SK: "META", kind: "image", byteSize: 42 },
      { PK: "F#1", SK: "META2", kind: "document", byteSize: 7 },
    ]);
    const [byNumber] = await store.queryItems({ pk: "F#1", filter: { byteSize: "42" } });
    expect(byNumber?.SK).toBe("META");
  });

  it("does not match a row that lacks the attribute", async () => {
    store.seed([{ PK: "F#2", SK: "META" }]);
    expect(await store.queryItems({ pk: "F#2", filter: { kind: "image" } })).toEqual([]);
  });

  it("runs before the limit, not over its result", async () => {
    store.seed([
      { PK: "F#3", SK: "a", kind: "image" },
      { PK: "F#3", SK: "b", kind: "image" },
      { PK: "F#3", SK: "c", kind: "document" },
    ]);
    const found = await store.queryItems({ pk: "F#3", limit: 1, filter: { kind: "document" } });
    expect(found.map((row) => row.SK)).toEqual(["c"]);
  });

  it("tests attribute presence before the limit, including a stored null", async () => {
    store.seed([
      { PK: "F#4", SK: "a", workspaceId: "w1" },
      { PK: "F#4", SK: "b", workspaceId: "w2" },
      { PK: "F#4", SK: "c" },
      { PK: "F#4", SK: "d", workspaceId: null },
    ]);
    const absent = await store.queryItems({ pk: "F#4", limit: 1, attributePresence: { attribute: "workspaceId", exists: false } });
    expect(absent.map(row => row.SK)).toEqual(["c"]);
    const present = await store.queryItems({ pk: "F#4", limit: 1, forward: false, attributePresence: { attribute: "workspaceId", exists: true } });
    expect(present.map(row => row.SK)).toEqual(["d"]);
  });
});
