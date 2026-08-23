import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "@/application/errors";

const { syncPluginsFromArchive, withAdminAuth, wrapped, repoConfig } = vi.hoisted(() => {
  // Counted outside the mock so `clearAllMocks` cannot forget the wrap that
  // happened at import.
  const wrapped = { count: 0 };
  return {
    syncPluginsFromArchive: vi.fn(),
    wrapped,
    withAdminAuth: (handler: (user: unknown, ...args: any[]) => unknown) => {
      wrapped.count += 1;
      return (...args: any[]) =>
        handler({ id: "u1", email: "admin@example.com", name: "A", image: null }, ...args);
    },
    repoConfig: {
    value: { repo: "opspresso/agent-plugins", branch: "main", token: undefined } as {
      repo: string | undefined;
      branch: string;
      token: string | undefined;
    },
  },
  };
});

vi.mock("@/lib/session", () => ({ withAdminAuth }));
vi.mock("@/lib/container", () => ({ syncPluginsFromArchive }));
vi.mock("@/lib/runtime-settings", () => ({
  getPluginsRepoConfig: vi.fn(async () => repoConfig.value),
}));

const { POST } = await import("@/app/api/plugins/sync/upload/route");

const URL_ = "https://studio.example.com/api/plugins/sync/upload";
const ARCHIVE = Buffer.from("gzip-bytes-stand-in");

function upload(fields: Record<string, string | Blob>, init: RequestInit = {}): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value instanceof Blob) {
      form.append(name, value, "plugins.tar.gz");
    } else {
      form.append(name, value);
    }
  }
  return POST(new Request(URL_, { method: "POST", body: form, ...init }));
}

const REPORT = {
  repo: "opspresso/agent-plugins",
  commitSha: "abc",
  plugins: [],
  skipped: [],
  orphanedPlugins: [],
  removedPlugins: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  repoConfig.value = { repo: "opspresso/agent-plugins", branch: "main", token: undefined };
  syncPluginsFromArchive.mockResolvedValue(REPORT);
});

describe("POST /api/plugins/sync/upload", () => {
  it("is an admin route", () => {
    expect(wrapped.count).toBe(1);
  });

  it("syncs the uploaded bytes under the configured repository, as the caller", async () => {
    const res = await upload({
      file: new Blob([ARCHIVE]),
      selection: JSON.stringify({ remove: { skills: ["old"] } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(syncPluginsFromArchive).toHaveBeenCalledTimes(1);
    const [bytes, repo, actor, selection] = syncPluginsFromArchive.mock.calls[0] ?? [];
    expect(Buffer.from(bytes as Uint8Array).equals(ARCHIVE)).toBe(true);
    expect(repo).toBe("opspresso/agent-plugins");
    expect(actor).toBe("admin@example.com");
    expect(selection).toEqual({ remove: { skills: ["old"] } });
  });

  it("falls back to the fixed archive name when no repository is configured", async () => {
    repoConfig.value = { repo: undefined, branch: "main", token: undefined };
    await upload({ file: new Blob([ARCHIVE]) });
    expect(syncPluginsFromArchive.mock.calls[0]?.[1]).toBe("archive");
    expect(syncPluginsFromArchive.mock.calls[0]?.[3]).toEqual({});
  });

  it("takes an explicit provenance name and refuses one that cannot be a source segment", async () => {
    await upload({ file: new Blob([ARCHIVE]), repo: "mirror/agent-plugins" });
    expect(syncPluginsFromArchive.mock.calls[0]?.[1]).toBe("mirror/agent-plugins");

    const res = await upload({ file: new Blob([ARCHIVE]), repo: "bad#name" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid `repo`/);
    expect(syncPluginsFromArchive).toHaveBeenCalledTimes(1);
  });

  it("answers 400 for a body that is not multipart, has no file, or an empty file", async () => {
    const json = await POST(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(json.status).toBe(400);
    expect((await json.json()).error).toMatch(/multipart\/form-data/);

    const noFile = await upload({ repo: "x/y" });
    expect(noFile.status).toBe(400);
    expect((await noFile.json()).error).toMatch(/Missing `file`/);

    const empty = await upload({ file: new Blob([]) });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toMatch(/empty/);
    expect(syncPluginsFromArchive).not.toHaveBeenCalled();
  });

  it("answers 400 for a selection that is not the removal shape", async () => {
    const notJson = await upload({ file: new Blob([ARCHIVE]), selection: "{nope" });
    expect(notJson.status).toBe(400);
    const wrongShape = await upload({
      file: new Blob([ARCHIVE]),
      selection: JSON.stringify({ remove: { skills: "gitops" } }),
    });
    expect(wrongShape.status).toBe(400);
    expect(syncPluginsFromArchive).not.toHaveBeenCalled();
  });

  it("refuses an upload over the cap before reading it", async () => {
    // A declared length over the cap is refused before a byte is read; a
    // string body so the refusal does not cancel a stream undici is still
    // filling from a FormData.
    const res = await POST(
      new Request(URL_, {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(33 * 1024 * 1024),
        },
        body: "--x--\r\n",
      }),
    );
    expect(res.status).toBe(413);
    expect(syncPluginsFromArchive).not.toHaveBeenCalled();
  });

  it("maps an unreadable archive to 400 and a running sync to 409", async () => {
    syncPluginsFromArchive.mockRejectedValueOnce(new ValidationError("not a tar archive"));
    const bad = await upload({ file: new Blob([ARCHIVE]) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("not a tar archive");

    syncPluginsFromArchive.mockRejectedValueOnce(new ConflictError("A plugins sync is already running"));
    expect((await upload({ file: new Blob([ARCHIVE]) })).status).toBe(409);
  });
});
