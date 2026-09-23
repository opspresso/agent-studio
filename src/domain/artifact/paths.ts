/** Authenticated Studio routes; file lifetime and viewer access are checked on read. */
export function artifactPath(id: string, action: "view" | "download"): string {
  return `/api/artifacts/${encodeURIComponent(id)}/${action}`;
}
