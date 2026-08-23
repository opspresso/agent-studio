import { modelCatalogDocumentUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { catalogBody } from "@/app/api/_lib/body";
import { withAdminAuth } from "@/lib/session";

/**
 * The catalog document an admin installs by hand — the offline path for a
 * deployment with no route to agent-models' published catalog
 * (`MODELS_CATALOG_URL=none`), though an upload wins over the network on any
 * deployment until it is removed.
 *
 * Three verbs on one address:
 *
 * - `GET` — `{ stored: false }` or the stored document's provenance and what
 *   the registry makes of it. A 200 either way: "nothing installed" is a
 *   state the console renders, not a failure.
 * - `PUT` — the catalog JSON as the body (at most 4MB). Validated the way a
 *   refresh validates it before it is stored — a 400 names the loader's
 *   reason — then stored with the caller's address and the time, then the
 *   registry is refreshed so the upload is live before this answers.
 *   `refreshed: false` beside `stored: true` means the registry already held
 *   this upload.
 * - `DELETE` — removes the document and refreshes; the registry follows the
 *   published catalog where one is read, and otherwise keeps what it holds
 *   until a restart (`modelCatalogDocument.ts` says why).
 *
 * A sibling of `GET /api/models/catalog` rather than more verbs on it: that
 * address is the member-rung view of the *registry*, and this one is the
 * admin's view of one *source* feeding it.
 */
export const GET = withAdminAuth(async () => {
  try {
    return Response.json(await modelCatalogDocumentUseCases.status());
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAdminAuth(async (user, request: Request) => {
  const body = await catalogBody(request);
  if (body instanceof Response) {
    return body;
  }
  try {
    return Response.json(await modelCatalogDocumentUseCases.install(body, user.email));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAdminAuth(async (user) => {
  try {
    return Response.json(await modelCatalogDocumentUseCases.remove(user.email));
  } catch (error) {
    return apiError(error);
  }
});
