import { z } from "zod";
import { capabilityVisibilityUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { isCapabilityUsageChanges, type CapabilityUsageChange } from "@/domain/plugin/visibility";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

const schema = z.object({ changes: z.custom<CapabilityUsageChange[]>(isCapabilityUsageChanges, "Invalid capability usage changes") }).strict();

export const GET = withAdminAuth(async () => {
  try {
    return Response.json(await capabilityVisibilityUseCases.getView());
  } catch (error) {
    return apiError(error);
  }
});

export const PATCH = withAdminAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = schema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    return Response.json(await capabilityVisibilityUseCases.update(parsed.data.changes, user.email));
  } catch (error) {
    return apiError(error);
  }
});
