/** Shared fetch helpers for the client-side api modules. */

import { redirectApiUnauthorized } from "./authRedirect";

export async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    if (redirectApiUnauthorized(res)) {
      throw new Error("Authentication required");
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function assertOk(res: Response): Promise<void> {
  if (!res.ok) {
    if (redirectApiUnauthorized(res)) {
      throw new Error("Authentication required");
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
}

export const jsonHeaders = { "Content-Type": "application/json" } as const;
