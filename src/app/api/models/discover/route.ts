import { z } from "zod";
import { modelRegistryUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import type { DiscoveredModel } from "@/domain/llm/providerModels";

export interface ModelDiscoveryResponse { models: DiscoveredModel[] }
export const GET = withAdminAuth(async (_user, request: Request) => {
  const parsed = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).safeParse(new URL(request.url).searchParams.get("provider"));
  if (!parsed.success) return invalidRequest(parsed.error);
  try { return Response.json({ models: await modelRegistryUseCases.discover(parsed.data) } satisfies ModelDiscoveryResponse); }
  catch (error) { return apiError(error); }
});
