import { z } from "zod";
import { modelRegistryUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { NotFoundError } from "@/application/errors";

export interface ModelStatusResponse { available: boolean }
export const GET = withAdminAuth(async (_user, request: Request) => {
  const parsed = z.string().min(1).max(200).safeParse(new URL(request.url).searchParams.get("id"));
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    const model = (await modelRegistryUseCases.list()).find(model => model.id === parsed.data);
    if (!model) throw new NotFoundError("Model is not registered");
    const models = await modelRegistryUseCases.discover(model.provider);
    return Response.json({ available: models.some(candidate => candidate.wireId === model.wireId) } satisfies ModelStatusResponse);
  } catch (error) { return apiError(error); }
});
