import { withAdminAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { bodyTooLarge } from "@/app/api/_lib/body";
import { BodyTooLargeError, readBodyBytes } from "@/shared/httpBody";
import { archiveSyncRepo } from "@/domain/plugin/sync";
import { getPluginsRepoConfig } from "@/lib/runtime-settings";
import { syncPluginsFromArchive } from "@/lib/container";
import { selectionSchema } from "../_lib/selection";

/**
 * Ceiling on the upload as sent. The plugins repository is text — a few
 * hundred kilobytes gzipped — so this is generous by two orders of magnitude
 * while keeping an admin's mistaken drag-and-drop of something else out of
 * memory. The inflated size has its own cap in the tar reader.
 */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/** Provenance is a `github:<repo>#<plugin>` segment: no `#`, nothing exotic. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

const badRequest = (error: string): Response => Response.json({ error }, { status: 400 });

/**
 * The plugins sync from an uploaded archive — `git archive --format=tar.gz
 * HEAD` of the plugins repository, or a `tar czf` of its checkout — for a
 * deployment with no route to GitHub. Multipart, with the archive in `file`;
 * `repo` names the provenance its rows carry (default: the configured
 * repository, else `archive`) and `selection` is the same removal JSON the
 * GitHub sync takes. Answers with the same report.
 */
export const POST = withAdminAuth(async (user, request: Request) => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return badRequest("Send the archive as multipart/form-data with a `file` field");
  }
  let body: Uint8Array;
  try {
    body = await readBodyBytes(request, MAX_UPLOAD_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return bodyTooLarge(error);
    }
    throw error;
  }
  // `readBodyBytes` hands back an ArrayBuffer-backed view; the cast says so.
  const form = await new Response(body as Uint8Array<ArrayBuffer>, {
    headers: { "content-type": contentType },
  })
    .formData()
    .catch(() => null);
  if (!form) {
    return badRequest("Malformed multipart body");
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return badRequest("Missing `file` field");
  }
  if (file.size === 0) {
    return badRequest("The archive is empty");
  }

  const repoField = form.get("repo");
  let repo: string;
  if (typeof repoField === "string" && repoField.trim() !== "") {
    if (!REPO_NAME.test(repoField.trim())) {
      return badRequest("Invalid `repo`: letters, digits, `.`, `_`, `-` and `/` only");
    }
    repo = repoField.trim();
  } else {
    repo = archiveSyncRepo((await getPluginsRepoConfig()).repo);
  }

  const selectionField = form.get("selection");
  let selectionJson: unknown = {};
  if (typeof selectionField === "string" && selectionField.trim() !== "") {
    try {
      selectionJson = JSON.parse(selectionField);
    } catch {
      return badRequest("Invalid selection");
    }
  }
  const selection = selectionSchema.safeParse(selectionJson);
  if (!selection.success) {
    return badRequest("Invalid selection");
  }

  try {
    const archive = new Uint8Array(await file.arrayBuffer());
    return Response.json(await syncPluginsFromArchive(archive, repo, user.email, selection.data));
  } catch (error) {
    // An unreadable archive is a ValidationError (400) and a sync already
    // running a ConflictError (409); nothing upstream was called.
    return apiError(error);
  }
});
