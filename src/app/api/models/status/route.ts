import { z } from "zod";
import { modelRegistryUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import type { RegisteredModelStatus } from "@/application/llm/modelRegistry";

export type ModelStatusResponse = RegisteredModelStatus;
export const GET = withAdminAuth(async (_user, request: Request) => {
  const parsed = z.string().min(1).max(200).safeParse(new URL(request.url).searchParams.get("id"));
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    return Response.json(await modelRegistryUseCases.status(parsed.data) satisfies ModelStatusResponse);
  } catch (error) { return apiError(error); }
});
