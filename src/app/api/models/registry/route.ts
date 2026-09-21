import { z } from "zod";
import { modelRegistryUseCases } from "@/lib/container";
import { withAdminAuth, withMemberAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";
import { REGISTRY_MODEL_TYPES, type RegisteredModel } from "@/domain/llm/providerModels";

const rate = z.number().finite().nonnegative();
const schema = z.object({
  id: z.string().min(1).max(200), provider: z.string().min(1).max(64),
  wireId: z.string().min(1).max(200), displayName: z.string().min(1).max(200),
  type: z.enum(REGISTRY_MODEL_TYPES),
  contextWindow: z.number().int().nonnegative(), maxTokens: z.number().int().nonnegative(),
  capabilities: z.object({ tools: z.boolean(), structuredOutput: z.boolean(), imageInput: z.boolean(), reasoning: z.boolean() }),
  pricing: z.object({ inputPer1M: rate, outputPer1M: rate, cachedInputPer1M: rate.optional(), imageInputPer1M: rate.optional(), imageOutputPer1M: rate.optional(), perImage: rate.optional(), perInputImage: rate.optional(), perSearch: rate.optional(), perAudioMinute: rate.optional() }).optional(),
});

export interface ModelRegistryResponse { models: RegisteredModel[] }

export const GET = withMemberAuth(async () => {
  try { return Response.json({ models: await modelRegistryUseCases.list() } satisfies ModelRegistryResponse); }
  catch (error) { return apiError(error); }
});

export const POST = withAdminAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = schema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    return Response.json({ models: await modelRegistryUseCases.save(parsed.data, user.email) } satisfies ModelRegistryResponse);
  } catch (error) { return apiError(error); }
});

export const DELETE = withAdminAuth(async (user, request: Request) => {
  const parsed = z.string().min(1).max(200).safeParse(new URL(request.url).searchParams.get("id"));
  if (!parsed.success) return invalidRequest(parsed.error);
  try { await modelRegistryUseCases.remove(parsed.data, user.email); return new Response(null, { status: 204 }); }
  catch (error) { return apiError(error); }
});
