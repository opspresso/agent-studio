import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactUseCases } from "@/application/artifact/artifactUseCases";
import { setAuditSink } from "@/application/audit/recordAudit";
import { setAdminCheck } from "@/application/project/projectUseCases";
import {
  baseMimeType,
  inlineViewOf,
  isInlineViewable,
  MAX_INLINE_VIEW_BYTES,
  SAVABLE_TYPES,
} from "@/domain/artifact/types";
import type { Artifact } from "@/domain/artifact/types";
import type { Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";

const OWNER = "owner@x.com";
const OTHER = "other@x.com";
const ADMIN = "admin@x.com";

const project: Project = {
  name: "report-bot",
  displayName: "Report",
  description: "",
  projectType: "agent",
  ownerEmail: OWNER,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    artifactId: "a1",
    kind: "document",
    source: "generated",
    key: "artifacts/document/a1.html",
    mimeType: "text/html",
    byteSize: 120,
    projectName: "report-bot",
    versionName: "1",
    actor: { kind: "user", id: OWNER },
    createdAt: "2026-08-22T00:00:00.000Z",
    ...over,
  };
}

const projects: ProjectRepository = {
  async get(name) {
    return name === project.name ? project : null;
  },
  async list() {
    return [project];
  },
  async create() {},
  async update() {},
  async delete() {},
  async getApiToken() {
    return null;
  },
  async setApiToken() {},
  async deleteApiToken() {},
};

function setup(stored: Artifact | null) {
  const reads: Array<{ key: string; maxBytes: number }> = [];
  const rows = {
    async put() {},
    async get(id: string) {
      return stored && stored.artifactId === id ? stored : null;
    },
    async listByProject() {
      return [];
    },
    async listByOwner() {
      return [];
    },
    async delete() {},
  };
  const objects = {
    async put() {},
    async read(key: string, maxBytes: number) {
      reads.push({ key, maxBytes });
      return { bytes: new TextEncoder().encode("<!doctype html><p>hi"), mimeType: "text/html" };
    },
    async sign(key: string) {
      return `https://signed/${key}`;
    },
    async delete() {},
  };
  return { useCases: createArtifactUseCases(rows, objects, projects), reads };
}

beforeEach(() => {
  setAdminCheck(async (email) => email === ADMIN);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("what may be viewed rather than downloaded", () => {
  it("admits text/html, with or without the charset parameter", () => {
    expect(inlineViewOf("text/html")).toBe("html");
    expect(inlineViewOf("text/html; charset=utf-8")).toBe("html");
    expect(inlineViewOf("TEXT/HTML")).toBe("html");
  });

  it("gives every other savable type its own kind, because each is shown as what it is", () => {
    // Not the same answer as HTML, and not the same as each other: HTML is
    // served as it was written, the rest are built here from the bytes — which
    // is what lets the view refuse them `allow-scripts`.
    expect(inlineViewOf("text/markdown")).toBe("markdown");
    expect(inlineViewOf("text/markdown; charset=utf-8")).toBe("markdown");
    expect(inlineViewOf("text/csv")).toBe("csv");
    expect(inlineViewOf("application/json")).toBe("json");
    expect(inlineViewOf("image/svg+xml")).toBe("svg");
    expect(inlineViewOf("text/plain")).toBe("text");
  });

  it("covers exactly what a run can write, and nothing a browser merely displays", () => {
    // The two lists agreeing is the point: a run writes these for a person to
    // read, so each is something this app can put on a screen. A PDF the
    // browser draws on its own never needed a sandbox.
    for (const mime of SAVABLE_TYPES) {
      expect(isInlineViewable(mime)).toBe(true);
    }
    for (const mime of ["application/pdf", "application/zip", "image/png"]) {
      expect(isInlineViewable(mime)).toBe(false);
      expect(inlineViewOf(mime)).toBeUndefined();
    }
  });
});

describe("reading an artifact for a view", () => {
  it("hands back the bytes to the person who produced it", async () => {
    const { useCases, reads } = setup(artifact());
    const { artifact: row, bytes, view } = await useCases.readForView("a1", OWNER);
    expect(row.mimeType).toBe("text/html");
    expect(view).toBe("html");
    expect(new TextDecoder().decode(bytes)).toContain("<!doctype html>");
    expect(reads).toEqual([{ key: "artifacts/document/a1.html", maxBytes: MAX_INLINE_VIEW_BYTES }]);
  });

  it("admits the person the row is filed under, however the run reached it", async () => {
    // The owner index is written with `artifactOwnerEmail(actor, ownerEmail)`,
    // and `ownerEmail` exists for the surfaces whose actor names no mailbox.
    // Asking without it, a report someone got from the Slack bot listed in
    // their own gallery and then answered 403 to every button on it.
    const viaSlack = artifact({ actor: { kind: "slack", id: "T123" }, ownerEmail: OWNER });
    await expect(setup(viaSlack).useCases.readForView("a1", OWNER)).resolves.toBeTruthy();
    await expect(setup(viaSlack).useCases.remove("a1", OWNER)).resolves.toBeUndefined();
  });

  it("does not record an admin override for a read", async () => {
    // `assertProjectWritable` writes a `project.admin-override` row every time
    // it admits an admin — the right record for a delete, and the wrong one for
    // a GET behind a link. Ten clicks through a gallery would be ten rows
    // claiming a write that never happened.
    const recorded: string[] = [];
    setAuditSink({
      append: async (row) => {
        recorded.push(row.action);
      },
      listByDay: async () => [],
    });
    await setup(artifact()).useCases.readForView("a1", ADMIN);
    expect(recorded).toEqual([]);

    await setup(artifact()).useCases.remove("a1", ADMIN);
    expect(recorded).toContain("project.admin-override");
  });

  it("admits an admin reaching into the project, and refuses everyone else", async () => {
    // The same predicate as a delete, deliberately: a gallery that lists a row
    // whose open button answers 403 is the shape two rules produce.
    await expect(setup(artifact()).useCases.readForView("a1", ADMIN)).resolves.toBeTruthy();
    await expect(setup(artifact()).useCases.readForView("a1", OTHER)).rejects.toThrow();
  });

  it("refuses a type that is downloaded rather than viewed, before reading it", async () => {
    const { useCases, reads } = setup(
      artifact({ mimeType: "application/pdf", key: "artifacts/document/a1.pdf" }),
    );
    await expect(useCases.readForView("a1", OWNER)).rejects.toThrow(/downloaded rather than viewed/);
    // The refusal costs nothing: a ten-megabyte deck is never pulled into memory
    // to be turned away afterwards.
    expect(reads).toEqual([]);
  });

  it("refuses a row larger than a view reads, before reading it", async () => {
    // The row already knows its size, so the adapter's own cap is never the one
    // that answers: that arrives untyped and reaches the reader as a 500.
    const { useCases, reads } = setup(artifact({ byteSize: MAX_INLINE_VIEW_BYTES + 1 }));
    await expect(useCases.readForView("a1", OWNER)).rejects.toThrow(/too large to open/);
    expect(reads).toEqual([]);
  });

  it("says which view a markdown row wants, so the route need not ask again", async () => {
    const { useCases } = setup(
      artifact({ mimeType: "text/markdown", key: "artifacts/document/a1.md" }),
    );
    await expect(useCases.readForView("a1", OWNER)).resolves.toMatchObject({ view: "markdown" });
  });

  it("is a 404 when no such row exists", async () => {
    const { useCases } = setup(null);
    await expect(useCases.readForView("missing", OWNER)).rejects.toThrow(/Artifact not found/);
  });
});

describe("the type a rule is written against", () => {
  it("is the type without its parameters", () => {
    expect(baseMimeType("text/html; charset=euc-kr")).toBe("text/html");
    expect(baseMimeType("  TEXT/HTML  ")).toBe("text/html");
  });

  it("is what the served header is built from, not the stored string", () => {
    // A row an MCP tool wrote may name a charset of its own, and
    // `text/html; charset=euc-kr; charset=utf-8` is read by the first one —
    // Korean text arriving as mojibake through the header meant to stop it.
    const served = `${baseMimeType("text/html; charset=euc-kr")}; charset=utf-8`;
    expect(served).toBe("text/html; charset=utf-8");
  });
});
