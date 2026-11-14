"use server";

import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/paths";
import { endSession, startSession } from "@/server/auth/actor";
import { devIdentityForEmail, upsertUserFromIdentity } from "@/server/auth/identity";
import { isDevAuthEnabled } from "@/server/env";
import { forbidden } from "@/server/errors";
import { failureState, formValues, text, type FormState } from "@/server/form-state";

/**
 * Development sign-in. Refuses to run unless AUTH_MODE=dev and the process is
 * not a production build; the check is made here, on the server, on every call.
 */
export async function devSignIn(_prev: FormState, formData: FormData): Promise<FormState> {
  let destination: string;
  try {
    if (!isDevAuthEnabled()) {
      throw forbidden("Development sign-in is disabled.");
    }
    const user = await upsertUserFromIdentity(devIdentityForEmail(text(formData, "email")));
    await startSession(user.id, "dev");
    destination = user.onboardedAt ? safeNextPath(text(formData, "next")) : "/onboarding";
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  redirect(destination);
}

export async function signOut(): Promise<void> {
  await endSession();
  redirect("/");
}
