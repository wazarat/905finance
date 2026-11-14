"use server";

import { refresh } from "next/cache";
import { enableRole } from "@/server/accounts";
import { failureState, text, type FormState } from "@/server/form-state";
import { requireActionWorkspace } from "@/server/page-context";

/** Add the buyer or seller role to the caller's own organization. Owner only. */
export async function enableRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await enableRole(actor, workspace.organization.id, text(formData, "role"));
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true };
}
