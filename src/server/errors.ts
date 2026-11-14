export type AppErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "conflict";

export type FieldErrors = Record<string, string[]>;

/**
 * Expected, user-facing failure raised by the data layer. Anything that is not
 * an AppError is treated as an unexpected fault by callers.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly fieldErrors?: FieldErrors;

  constructor(code: AppErrorCode, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export const unauthenticated = () => new AppError("unauthenticated", "Sign in to continue.");
export const forbidden = (message = "You don't have permission to do that.") =>
  new AppError("forbidden", message);
export const notFound = (what = "Resource") => new AppError("not_found", `${what} not found.`);
export const conflict = (message: string) => new AppError("conflict", message);
export const invalid = (message: string, fieldErrors?: FieldErrors) =>
  new AppError("invalid", message, fieldErrors);

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
