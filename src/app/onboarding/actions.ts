"use server";

import { redirect } from "next/navigation";
import { completeOnboarding } from "@/server/accounts";
import { getActor } from "@/server/auth/actor";
import { failureState, formValues, text, type FormState } from "@/server/form-state";

export async function submitOnboarding(_prev: FormState, formData: FormData): Promise<FormState> {
  let destination: string;
  try {
    const actor = await getActor();
    const workspace = await completeOnboarding(actor, {
      displayName: text(formData, "displayName"),
      organizationName: text(formData, "organizationName"),
      accountType: text(formData, "accountType"),
      roles: text(formData, "roles"),
      sellerDisplayName: text(formData, "sellerDisplayName") || undefined,
    });
    destination = workspace.buyerProfile ? "/dashboard" : "/seller/listing";
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  redirect(destination);
}
