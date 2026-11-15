"use server";

import { refresh } from "next/cache";
import { failureState, formValues, text, type FormState } from "@/server/form-state";
import { linkBuyerIdentity, refreshBuyerIdentity, unlinkBuyerIdentity } from "@/server/identity";
import { requireActionWorkspace } from "@/server/page-context";

/** Link the organization's buying agent to its ERC-8004 agent id. The rest is read from the chain. */
export async function linkBuyerIdentityAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let confirmed: boolean;
  try {
    const { actor, workspace } = await requireActionWorkspace();
    confirmed = (await linkBuyerIdentity(actor, workspace.organization.id, { agentId: text(formData, "agentId") }))
      .confirmed;
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return {
    ok: true,
    message: confirmed
      ? "Linked and confirmed: the agent's registration is your buying agent's document."
      : "Linked as an unconfirmed claim. See below for what confirms it.",
  };
}

export async function refreshBuyerIdentityAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await refreshBuyerIdentity(actor, workspace.organization.id);
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Read again from GOAT Testnet3." };
}

export async function unlinkBuyerIdentityAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await unlinkBuyerIdentity(actor, workspace.organization.id);
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Identity unlinked." };
}
