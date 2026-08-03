import { z } from "zod";
import { organizationUseCases } from "@/lib/container";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { isDeploymentAdmin, withAuth, withDeploymentAdminAuth } from "@/lib/session";
import { invalidateWorkspaceCache } from "@/lib/workspace";

/**
 * The workspace registry — what makes the tenant scheme reachable from the
 * product rather than only from the table.
 *
 * Reading is scoped to what the caller has business seeing: a deployment
 * operator sees every workspace, anyone else sees the one they are in. The list
 * is not secret, but it is also not a directory of other customers.
 *
 * Writing is a deployment-level act. The id becomes the key prefix every row of
 * that tenant carries, so creating one changes what the installation is — which
 * is not a workspace admin's to decide about a workspace that is not theirs.
 */
const createSchema = z.object({
  id: z.string().min(1).max(64),
  displayName: z.string().max(200).optional(),
});

export const GET = withAuth(async (user) => {
  try {
    const all = await organizationUseCases.list();
    if (await isDeploymentAdmin(user)) {
      return Response.json({ organizations: all });
    }
    return Response.json({
      organizations: all.filter((organization) => organization.id === user.tenant),
    });
  } catch (error) {
    return apiError(error);
  }
});

export const POST = withDeploymentAdminAuth(async (user, request: Request) => {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const organization = await organizationUseCases.create(
      { id: parsed.data.id, displayName: parsed.data.displayName ?? "" },
      user.email,
    );
    // The creator became its admin, which changes their own resolved workspace.
    invalidateWorkspaceCache();
    return Response.json(organization, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
});
