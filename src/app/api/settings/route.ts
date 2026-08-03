import { z } from "zod";
import { settingsUseCases } from "@/lib/container";
import { SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { apiError } from "@/app/api/_lib/http";
import { invalidateSettingsCache } from "@/lib/runtime-settings";
import { withDeploymentAdminAuth } from "@/lib/session";

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
      }),
    )
    .max(50)
    .optional(),
  skillsRepo: z.string().max(4000).optional(),
  skillsRepoBranch: z.string().max(4000).optional(),
  toolsRepo: z.string().max(4000).optional(),
  toolsRepoBranch: z.string().max(4000).optional(),
  githubToken: z.string().max(4000).optional(),
  a2aApiKey: z.string().max(4000).optional(),
  // An enum rather than a free string, because "reufse" would parse, store, and
  // silently mean `allow` — `getUnknownModelPolicy` refuses only on the exact
  // word. An empty string is how a field is cleared back to the env layer.
  unknownModelPolicy: z.enum(["allow", "refuse", ""]).optional(),
  publicBaseUrl: z.string().max(4000).optional(),
});

export const GET = withDeploymentAdminAuth(async () => {
  return Response.json(await settingsUseCases.getView());
});

export const PUT = withDeploymentAdminAuth(async (user, request: Request) => {
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
