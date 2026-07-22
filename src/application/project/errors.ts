/**
 * Project/version domain errors. These are the shared application errors,
 * re-exported so existing imports (`@/application/project/errors`) keep working
 * while the class identities live in one place (`@/application/errors`).
 */
export {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  statusForError,
} from "@/application/errors";
