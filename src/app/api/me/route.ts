import { withAuth } from "@/lib/session";
import { resolveViewer } from "@/lib/viewer";

/**
 * Who the caller is, for the console's own gating.
 *
 * The flags and why both are sent are owned by `src/lib/viewer.ts`, which the
 * root layout also calls — the chrome resolves the viewer server-side, so this
 * endpoint now serves only the pages that ask after they have mounted.
 */
export const GET = withAuth(async (user) => Response.json(await resolveViewer(user)));
