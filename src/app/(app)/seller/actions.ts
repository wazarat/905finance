"use server";

import { refresh } from "next/cache";
import { failureState, formValues, text, type FormState } from "@/server/form-state";
import { requireActionWorkspace } from "@/server/page-context";
import { respondToCase } from "@/server/reputation";

/** The seller's reply to a case 905 Finance is reviewing. Given once. */
export async function respondToCaseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await respondToCase(actor, text(formData, "caseId"), { response: text(formData, "response") });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return { ok: true, message: "Reply sent to 905 Finance." };
}
