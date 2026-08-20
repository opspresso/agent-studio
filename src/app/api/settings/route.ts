import { z } from "zod";
import { settingsUseCases } from "@/lib/container";
import { SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
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
  artifactAccessMode: z.enum(["authenticated", "public", ""]).optional(),
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
  // Full replacement; empty array removes every declaration. Shape-level only —
  // the semantic rules (zero pricing, catalog collisions, family agreement)
  // are the registry loader's, applied in the use case.
  selfHostedModels: z
    .array(
      z.object({
        // The serving stack's own name — no whitespace or control characters,
        // which would otherwise ride into ids, log lines, and dispatch.
        family: z.string().min(1).max(200).regex(/^\S+$/u, "must not contain whitespace"),
        displayName: z.string().min(1).max(200),
        maker: z.string().max(100).optional(),
        contextWindow: z.number().int().positive(),
        maxTokens: z.number().int().positive(),
        capabilities: z.object({
          tools: z.boolean(),
          structuredOutput: z.boolean(),
          imageInput: z.boolean(),
          reasoning: z.boolean(),
        }),
      }),
    )
    .max(50)
    .optional(),
});

export const GET = withAdminAuth(async () => {
  return Response.json(await settingsUseCases.getView());
});

export const PUT = withAdminAuth(async (user, request: Request) => {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // `invalidRequest` puts the first issue's path in the error text — the
    // form shows only that string, and "Invalid input" alone left an admin
    // guessing which of a dozen fields a save died on.
    return invalidRequest(parsed.error);
  }
  try {
    const view = await settingsUseCases.update(parsed.data, user.email);
    invalidateSettingsCache();
    return Response.json(view);
  } catch (error) {
    return apiError(error);
  }
});
