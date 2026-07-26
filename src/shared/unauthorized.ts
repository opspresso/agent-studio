/** The single 401 shape: both auth paths (session, project API token) return it. */
export const unauthorized = (): Response =>
  Response.json({ error: "Unauthorized" }, { status: 401 });
