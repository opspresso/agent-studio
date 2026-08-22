/**
 * The single 401 shape: both auth paths (session, project API token) return it.
 *
 * A surface whose card or metadata declares how to authenticate names the
 * scheme in `WWW-Authenticate`, so a client that reads the challenge learns
 * what to present; the body stays the one every 401 here answers with.
 */
export const unauthorized = (challenge?: string): Response =>
  Response.json(
    { error: "Unauthorized" },
    { status: 401, ...(challenge ? { headers: { "WWW-Authenticate": challenge } } : {}) },
  );
