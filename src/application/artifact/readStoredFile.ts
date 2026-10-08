import { ObjectNotFoundError } from "@/domain/artifact/objectStore";
import { NotFoundError } from "@/application/errors";

/** Missing bytes can outlive their metadata; keep other storage failures distinct. */
export async function readStoredFile<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      throw new NotFoundError("That file is no longer stored");
    }
    throw error;
  }
}
