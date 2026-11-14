"use server";

import { cookies, headers } from "next/headers";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { isProduction } from "@/server/env";
import { failureState, type FormState } from "@/server/form-state";
import { requireActionWorkspace } from "@/server/page-context";
import { QATOM_PENDING_COOKIE } from "@/server/qatom/config";
import { disconnectQatom, sealPending, startQatomConnect } from "@/server/qatom/connection";

/** The address this request was made to, which is where Qatom must send the owner back. */
async function requestOrigin(): Promise<string> {
  const store = await headers();
  const host = store.get("x-forwarded-host") ?? store.get("host") ?? "";
  const protocol = isProduction() ? "https" : (store.get("x-forwarded-proto") ?? "http");
  return `${protocol}://${host}`;
}

/** Send the owner to Qatom to sign in. Nothing is linked until they come back with Qatom's answer. */
export async function connectQatomAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  let destination: string;
  try {
    const { actor, workspace } = await requireActionWorkspace();
    const origin = await requestOrigin();
    const { url, pending } = await startQatomConnect(
      actor,
      workspace.organization.id,
      `${origin}/api/qatom/callback`,
    );
    (await cookies()).set(QATOM_PENDING_COOKIE, await sealPending(pending), {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction(),
      path: "/api/qatom",
      maxAge: 10 * 60,
    });
    destination = url;
  } catch (error) {
    return failureState(error);
  }
  redirect(destination);
}

export async function disconnectQatomAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await disconnectQatom(actor, workspace.organization.id);
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Qatom account unlinked." };
}
