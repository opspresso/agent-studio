import { z } from "zod";
import { organizationUseCases } from "@/lib/container";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { isDeploymentAdmin, withAuth, withDeploymentAdminAuth } from "@/lib/session";
import { isConfiguredAdmin } from "@/lib/runtime-settings";
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
  /*
   * Naming the operators is a precondition of the first workspace, because
   * creating one is what ends the rule that admitted this caller.
   *
   * With no admin list configured, `isDeploymentAdmin` falls open on a
   * deployment that has no workspaces — and the moment one exists it stops,
   * for everybody. A caller admitted by that fail-open who creates a workspace
   * therefore locks the whole deployment out of every deployment-admin surface
   * *including the settings write that would name an admin*, leaving an
   * environment variable and a redeploy as the only way back.
   *
   * So the caller must be someone the deployment actually named. It is not an
   * extra permission — anyone who can reach here can also write the admin list
   * first, which is exactly the step being asked for.
   */
  if (!(await isConfiguredAdmin(user.email))) {
    return Response.json(
      {
        error:
          "Set the deployment's admin emails before creating the first workspace — " +
          "otherwise creating one leaves nobody able to administer this deployment.",
      },
      { status: 409 },
    );
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
