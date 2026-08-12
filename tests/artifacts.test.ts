import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactObjectKey, artifactOwnerEmail } from "@/domain/artifact/types";
import { RETENTION } from "@/infrastructure/db/ttl";
import type { Artifact } from "@/domain/artifact/types";

interface Captured {
  constructor: { name: string };
  input: Record<string, any>;
}

const { state, fakeClient } = vi.hoisted(() => {
  const state = {
    sent: [] as Captured[],
    getItem: undefined as Record<string, unknown> | undefined,
    queryPages: [] as Array<{ Items: Record<string, unknown>[]; LastEvaluatedKey?: unknown }>,
  };
  const fakeClient = {
    async send(command: Captured) {
      state.sent.push(command);
      const name = command.constructor?.name;
      if (name === "GetCommand") {
        return { Item: state.getItem };
      }
      if (name === "QueryCommand") {
        return state.queryPages.shift() ?? { Items: [], LastEvaluatedKey: undefined };
      }
      return {};
    },
  };
  return { state, fakeClient };
});

vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

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

/** What the repository would read back, as DynamoDB would hand it over. */
function item(over: Partial<Artifact> & Record<string, unknown> = {}): Record<string, unknown> {
  return { ...artifact(over as Partial<Artifact>), expiresAt: freshSec, ...over };
}

function lastPut(): Record<string, any> {
  const puts = state.sent.filter((c) => c.constructor.name === "PutCommand");
  return puts[puts.length - 1]?.input.Item ?? {};
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
  state.sent = [];
  state.getItem = undefined;
  state.queryPages = [];
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
    expect(lastPut()).toMatchObject({
      PK: "ARTIFACT#a1",
      SK: "META",
      entityType: "ARTIFACT",
      GSI1PK: "ARTIFACTPROJECT#poster-bot",
      GSI1SK: `${CREATED}#a1`,
    });
  });

  it("also indexes by owner when the actor names an email", async () => {
    await artifactRepository.put(artifact());
    expect(lastPut()).toMatchObject({
      GSI2PK: "ARTIFACTOWNER#bruce@daangn.com",
      GSI2SK: `${CREATED}#a1`,
    });
  });

  it("leaves the owner index empty for a run nobody's mailbox caused", async () => {
    // Sparse rather than a placeholder: a Slack artifact is reachable through
    // its project, and a row under a fake owner would be listed for nobody.
    await artifactRepository.put(artifact({ actor: { kind: "slack", id: "U123" } }));
    const stored = lastPut();
    expect(stored.GSI2PK).toBeUndefined();
    expect(stored.GSI2SK).toBeUndefined();
    // Still findable, which is the whole reason the project index is not optional.
    expect(stored.GSI1PK).toBe("ARTIFACTPROJECT#poster-bot");
  });

  it("expires the row on the artifact retention window", async () => {
    await artifactRepository.put(artifact());
    expect(lastPut().expiresAt).toBe(
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
    state.getItem = item({ filename: "report.pdf", kind: "document", prompt: "요약해줘" });
    const found = await artifactRepository.get("a1");
    expect(found).toMatchObject({
      artifactId: "a1",
      kind: "document",
      filename: "report.pdf",
      prompt: "요약해줘",
      actor: { kind: "user", id: "bruce@daangn.com" },
    });
  });

  it("treats an expired row as gone — the physical purge lags by up to 48h", async () => {
    state.getItem = { ...item(), expiresAt: expiredSec };
    expect(await artifactRepository.get("a1")).toBeNull();
  });

  it("returns null for a row that is not there", async () => {
    expect(await artifactRepository.get("nope")).toBeNull();
  });
});

describe("listing", () => {
  it("queries the project index newest first", async () => {
    state.queryPages = [{ Items: [item()], LastEvaluatedKey: undefined }];
    await artifactRepository.listByProject("poster-bot");
    const query = state.sent.find((c) => c.constructor.name === "QueryCommand")!;
    expect(query.input.IndexName).toBe("GSI1");
    expect(query.input.ScanIndexForward).toBe(false);
    expect(query.input.ExpressionAttributeValues[":pk"]).toBe("ARTIFACTPROJECT#poster-bot");
  });

  it("queries the owner index for a person", async () => {
    state.queryPages = [{ Items: [item()], LastEvaluatedKey: undefined }];
    await artifactRepository.listByOwner("bruce@daangn.com");
    const query = state.sent.find((c) => c.constructor.name === "QueryCommand")!;
    expect(query.input.IndexName).toBe("GSI2");
    expect(query.input.ExpressionAttributeValues[":pk"]).toBe("ARTIFACTOWNER#bruce@daangn.com");
  });

  it("drops expired rows the query still returned", async () => {
    state.queryPages = [
      {
        Items: [item({ artifactId: "fresh" }), { ...item({ artifactId: "old" }), expiresAt: expiredSec }],
        LastEvaluatedKey: undefined,
      },
    ];
    const found = await artifactRepository.listByProject("poster-bot");
    expect(found.map((a) => a.artifactId)).toEqual(["fresh"]);
  });

  it("refills a page thinned by a kind filter instead of returning it short", async () => {
    // DynamoDB applies Limit before anything here can filter, so "images only"
    // would ask for 2 and get 1 without the refill loop.
    state.queryPages = [
      {
        Items: [item({ artifactId: "doc1", kind: "document" }), item({ artifactId: "img1" })],
        LastEvaluatedKey: { PK: "cursor" },
      },
      { Items: [item({ artifactId: "img2" })], LastEvaluatedKey: undefined },
    ];
    const found = await artifactRepository.listByProject("poster-bot", { limit: 2, kind: "image" });
    expect(found.map((a) => a.artifactId)).toEqual(["img1", "img2"]);
  });

  it("filters by source as well", async () => {
    state.queryPages = [
      {
        Items: [item({ artifactId: "gen" }), item({ artifactId: "att", source: "attachment" })],
        LastEvaluatedKey: undefined,
      },
    ];
    const found = await artifactRepository.listByProject("poster-bot", { source: "attachment" });
    expect(found.map((a) => a.artifactId)).toEqual(["att"]);
  });

  it("stops after the page bound so a partition of expired rows is not a full scan", async () => {
    state.queryPages = Array.from({ length: 12 }, () => ({
      Items: [{ ...item(), expiresAt: expiredSec }],
      LastEvaluatedKey: { PK: "cursor" },
    }));
    await artifactRepository.listByProject("poster-bot", { limit: 5 });
    expect(state.sent.filter((c) => c.constructor.name === "QueryCommand")).toHaveLength(5);
  });

  it("pages with the previous page's last sort key, and does not repeat that row", async () => {
    const cursor = `${CREATED}#a1`;
    state.queryPages = [
      {
        Items: [item({ artifactId: "a1" }), item({ artifactId: "a0", createdAt: "2026-07-30T00:00:00.000Z" })],
        LastEvaluatedKey: undefined,
      },
    ];
    const found = await artifactRepository.listByProject("poster-bot", { before: cursor });
    const query = state.sent.find((c) => c.constructor.name === "QueryCommand")!;
    expect(query.input.ExpressionAttributeValues[":to"]).toBe(cursor);
    expect(found.map((a) => a.artifactId)).toEqual(["a0"]);
  });

  it("includes the whole 'to' day rather than only its midnight", async () => {
    state.queryPages = [{ Items: [], LastEvaluatedKey: undefined }];
    await artifactRepository.listByProject("poster-bot", { from: "2026-08-01", to: "2026-08-12" });
    const query = state.sent.find((c) => c.constructor.name === "QueryCommand")!;
    expect(query.input.ExpressionAttributeValues[":to"]).toBe("2026-08-12￿");
  });

  it("caps the page at 100 however much a caller asks for", async () => {
    state.queryPages = [{ Items: [], LastEvaluatedKey: undefined }];
    await artifactRepository.listByProject("poster-bot", { limit: 5000 });
    const query = state.sent.find((c) => c.constructor.name === "QueryCommand")!;
    expect(query.input.Limit).toBe(100);
  });
});

describe("delete", () => {
  it("removes the row by its own key", async () => {
    await artifactRepository.delete("a1");
    const deleted = state.sent.find((c) => c.constructor.name === "DeleteCommand")!;
    expect(deleted.input.Key).toEqual({ PK: "ARTIFACT#a1", SK: "META" });
  });
});
