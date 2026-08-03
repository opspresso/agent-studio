import { z } from "zod";
import { tenantSettingsUseCases } from "@/lib/container";
import { SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { invalidateSettingsCache } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";

/**
 * One workspace's own settings — the layer that sits above the deployment's on
 * the `/settings` page and below nothing.
 *
 * Admin of *this* workspace, which `withAdminAuth` already means: inside a
 * workspace it is the membership role that answers, so there is no second gate
 * to keep in step. The tenant is the caller's own and is never taken from the
 * body — a workspace admin is an admin of theirs, not of one they can name.
 *
 * A write invalidates the settings cache the way the app-level page does, with
 * the same process-local limit: on a multi-instance deployment the change lands
 * elsewhere when those instances' entries expire.
 */

/**
 * Narrowed to what a workspace may decide, and typed rather than trusted. Only
 * a schema can stop `llmProviders: "abc"` — which is `length === 3`, so it was
 * stored verbatim and broke every run in the workspace on the next provider
 * read.
 *
 * `.strict()`, because zod's default is to *strip* what it does not know. That
 * made the use case's "named rather than silently dropped" rejection of a
 * non-overridable key unreachable from the only route that calls it: the key
 * was gone before the check saw it, and the answer was a 200 that mentioned
 * nothing. Rejecting here is what makes the guard behind it true.
 */
const updateSchema = z.strictObject({
  llmBaseUrl: z.string().max(4000).optional(),
  llmApiKey: z.string().max(4000).optional(),
  llmProviders: z
    .array(
      z.object({
        name: z.enum(SUPPORTED_PROVIDERS),
        baseUrl: z.string().max(4000),
        apiKey: z.string().max(4000),
        keepModelPrefix: z.boolean().optional(),
      }),
    )
    .max(50)
    .optional(),
  skillsRepo: z.string().max(4000).optional(),
  skillsRepoBranch: z.string().max(4000).optional(),
  toolsRepo: z.string().max(4000).optional(),
  toolsRepoBranch: z.string().max(4000).optional(),
  githubToken: z.string().max(4000).optional(),
  unknownModelPolicy: z.enum(["allow", "refuse", ""]).optional(),
});

export const GET = withAdminAuth(async (user) => {
  try {
    return Response.json(await tenantSettingsUseCases.getView(user.tenant));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAdminAuth(async (user, request: Request) => {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const view = await tenantSettingsUseCases.update(user.tenant, parsed.data, user.email);
    // This workspace's entry, not the whole map: one row changed.
    invalidateSettingsCache(user.tenant);
    return Response.json(view);
  } catch (error) {
    return apiError(error);
  }
});
