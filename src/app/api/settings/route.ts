import { z } from "zod";
import { settingsUseCases } from "@/lib/container";
import { SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { apiError } from "@/app/api/_lib/http";
import { invalidateSettingsCache } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";

const updateSchema = z.object({
  adminEmails: z.string().max(4000).optional(),
  allowedEmailDomains: z.string().max(4000).optional(),
  llmBaseUrl: z.string().max(4000).optional(),
  llmApiKey: z.string().max(4000).optional(),
  llmProviders: z
    .array(
      z.object({
        name: z.enum(SUPPORTED_PROVIDERS),
        baseUrl: z.string().max(4000),
        apiKey: z.string().max(4000),
        keepModelPrefix: z.boolean().optional(),
        auth: z.enum(["bearer", "sigv4"]).optional(),
      }),
    )
    .max(50)
    .optional(),
  // "owner/repo" or empty (clears the override). Free text here surfaced a
  // typo only as "GitHub /repos/x//git/ref failed: 404" at the first sync.
  pluginsRepo: z
    .union([z.literal(""), z.string().max(200).regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/repo")])
    .optional(),
  pluginsRepoBranch: z.string().max(200).optional(),
  githubToken: z.string().max(4000).optional(),
  a2aApiKey: z.string().max(4000).optional(),
  publicBaseUrl: z.string().max(4000).optional(),
  // An enum rather than a bounded string: the two values are the whole domain,
  // and a typo silently stored as an override would read back as `allow` on a
  // deployment that asked to refuse.
  //
  // The empty string is in the set because it is not a third value — it is how
  // *every* field on this page removes its override and falls back to the
  // environment, and the page says so in as many words. Without it the one
  // field that cannot be cleared would fail the whole save, losing every other
  // edit in the form along with it.
  unknownModelPolicy: z.enum(["allow", "refuse", ""]).optional(),
  // Full replacement; empty array clears the override (every model offered).
  enabledModels: z.array(z.string().max(200)).max(200).optional(),
});

export const GET = withAdminAuth(async () => {
  return Response.json(await settingsUseCases.getView());
});

export const PUT = withAdminAuth(async (user, request: Request) => {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const view = await settingsUseCases.update(parsed.data, user.email);
    invalidateSettingsCache();
    return Response.json(view);
  } catch (error) {
    return apiError(error);
  }
});
