import { withAuth } from "@/lib/session";
import { projectRepository } from "@/lib/container";
import { createProject, listProjects } from "@/application/project/projectUseCases";
import { createProjectSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeProject } from "@/app/api/projects/_lib/http";

export const GET = withAuth(async () => {
  return Response.json((await listProjects(projectRepository)).map(sanitizeProject));
});

export const POST = withAuth(async (user, request: Request) => {
  const parsed = createProjectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await createProject(projectRepository, {
      ...parsed.data,
      ownerEmail: user.email,
    });
    return Response.json(sanitizeProject(project), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
