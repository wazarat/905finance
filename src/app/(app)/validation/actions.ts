"use server";

import { refresh } from "next/cache";
import { failureState, formValues, text, type FormState } from "@/server/form-state";
import { requireActionWorkspace } from "@/server/page-context";
import { decideCase } from "@/server/reputation";

/** A 905 Finance validator's verdict. Who may give it is decided in the data layer, from the verified sign-in. */
export async function decideCaseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await decideCase(actor, text(formData, "caseId"), {
      verdict: text(formData, "verdict"),
      score: text(formData, "score"),
      note: text(formData, "note"),
      confirmed: formData.get("confirmed") === "on",
    });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return { ok: true, message: "Verdict recorded." };
}
