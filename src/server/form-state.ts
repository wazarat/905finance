import { isAppError, type FieldErrors } from "./errors";

/** Result of a form-backed server action, consumed with `useActionState`. */
export type FormState = {
  ok: boolean;
  message?: string;
  fieldErrors?: FieldErrors;
  /** Submitted values echoed back so a failed form keeps what the user typed. */
  values?: Record<string, string | string[]>;
};

export const initialFormState: FormState = { ok: false };

/**
 * Convert an expected failure into form state. Anything unexpected (including
 * framework redirects) is rethrown untouched.
 */
export function failureState(error: unknown, values?: FormState["values"]): FormState {
  if (isAppError(error)) {
    return { ok: false, message: error.message, fieldErrors: error.fieldErrors, values };
  }
  throw error;
}

/** Plain string fields from a form, for echoing back after a failed submit. */
export function formValues(formData: FormData): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  for (const key of new Set(formData.keys())) {
    if (key.startsWith("$")) continue;
    const all = formData.getAll(key).filter((v): v is string => typeof v === "string");
    values[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return values;
}

export function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export function textList(formData: FormData, key: string): string[] {
  return formData.getAll(key).filter((v): v is string => typeof v === "string");
}
