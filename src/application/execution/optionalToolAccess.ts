import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";

/** An optional tool may be absent for a known refusal; an authorization outage must fail the run. */
export async function optionalToolAccessible(authorize: () => Promise<unknown>): Promise<boolean> {
  try {
    await authorize();
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError || error instanceof ValidationError) {
      return false;
    }
    throw error;
  }
}
