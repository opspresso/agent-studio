import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactUseCases } from "@/application/artifact/artifactUseCases";
import { setAdminCheck } from "@/application/project/projectUseCases";
import { isInlineViewable, MAX_INLINE_VIEW_BYTES } from "@/domain/artifact/types";
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
  async publish() {},
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
    expect(isInlineViewable("text/html")).toBe(true);
    expect(isInlineViewable("text/html; charset=utf-8")).toBe(true);
    expect(isInlineViewable("TEXT/HTML")).toBe(true);
  });

  it("refuses everything else", () => {
    // Not a display question. A type belongs on that list by being worth a
    // sandbox, and a PDF the browser renders on its own never needed one.
    for (const mime of ["application/pdf", "text/plain", "image/svg+xml", "text/markdown"]) {
      expect(isInlineViewable(mime)).toBe(false);
    }
  });
});

describe("reading an artifact for a view", () => {
  it("hands back the bytes to the person who produced it", async () => {
    const { useCases, reads } = setup(artifact());
    const { artifact: row, bytes } = await useCases.readForView("a1", OWNER);
    expect(row.mimeType).toBe("text/html");
    expect(new TextDecoder().decode(bytes)).toContain("<!doctype html>");
    expect(reads).toEqual([{ key: "artifacts/document/a1.html", maxBytes: MAX_INLINE_VIEW_BYTES }]);
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

  it("is a 404 when no such row exists", async () => {
    const { useCases } = setup(null);
    await expect(useCases.readForView("missing", OWNER)).rejects.toThrow(/Artifact not found/);
  });
});
