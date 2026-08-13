import { withAuth } from "@/lib/session";
import { createProjectWithInitialVersion, projectUseCases } from "@/lib/container";
import { createProjectSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeProject } from "@/app/api/projects/_lib/http";

export const GET = withAuth(async () => {
  return Response.json((await projectUseCases.list()).map(sanitizeProject));
});

export const POST = withAuth(async (user, request: Request) => {
  const parsed = createProjectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    // Project plus its initial version "1" — see createProjectFlow.ts for why
    // the version is created and deliberately not published.
    const project = await createProjectWithInitialVersion({
      ...parsed.data,
      ownerEmail: user.email,
    });
    return Response.json(sanitizeProject(project), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
