import { z } from "zod";
import { modelSelectionUseCases } from "@/lib/container";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";
import { withAdminAuth } from "@/lib/session";

const selectionSchema = z.object({
  type: z.enum(["embedding", "rerank"]),
  model: z.string().min(1).max(200),
  migrate: z.boolean().optional(),
  rerankerMinScore: z.number().min(0).max(1).optional(),
});

export const PUT = withAdminAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = selectionSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(
      await modelSelectionUseCases.select(
        parsed.data.type,
        parsed.data.model,
        parsed.data.migrate === true,
        user.email,
        parsed.data.rerankerMinScore,
      ),
    );
  } catch (error) {
    return apiError(error);
  }
});
