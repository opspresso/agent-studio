import { z } from "zod";
import { isSlug, SLUG_RULE } from "@/shared/slug";
import { skillUseCases } from "@/lib/container";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

const createSchema = z.object({
  name: z.string().refine(isSlug, `name ${SLUG_RULE}`),
  description: z.string().min(1),
  content: z.string(),
});

export const GET = withAuth(async () => {
  // A summary, not the entity: the list pages render a name, a description
  // and two badges, while a full skill carries its whole markdown body and up
  // to 200KB of attachments. Detail readers use GET /api/skills/{name}.
  const skills = await skillUseCases.list();
  return Response.json(
    skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      files: skill.files?.length ?? 0,
      updatedAt: skill.updatedAt,
    })),
  );
});

export const POST = withAdminAuth(async (_user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await skillUseCases.create(parsed.data), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
