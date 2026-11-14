"use server";

import { refresh } from "next/cache";
import { parseMoneyToMinor } from "@/lib/money";
import { invalid } from "@/server/errors";
import {
  failureState,
  formValues,
  text,
  textList,
  type FormState,
} from "@/server/form-state";
import { linkSellerIdentity, refreshOwnSellerIdentity, unlinkSellerIdentity } from "@/server/identity";
import { requireActionWorkspace } from "@/server/page-context";
import {
  createOffering,
  deleteOffering,
  saveSellerEndpoint,
  submitSellerListing,
  updateSellerListing,
  withdrawSellerListing,
} from "@/server/sellers";

// Every action resolves the organization from the verified session. No
// organization, listing or seller id is accepted from the form.

export async function saveListingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await updateSellerListing(actor, workspace.organization.id, {
      displayName: text(formData, "displayName"),
      tagline: text(formData, "tagline"),
      description: text(formData, "description"),
      capabilities: textList(formData, "capabilities"),
    });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return { ok: true, message: "Listing saved." };
}

export async function saveEndpointAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await saveSellerEndpoint(actor, workspace.organization.id, {
      url: text(formData, "url"),
      protocol: text(formData, "protocol"),
    });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return { ok: true, message: "Endpoint saved." };
}

export async function addOfferingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    const priceMinor = parseMoneyToMinor(text(formData, "price"));
    if (priceMinor === null) {
      throw invalid("Check the highlighted fields.", {
        price: ["Enter a price such as 25 or 25.50."],
      });
    }
    await createOffering(actor, workspace.organization.id, {
      name: text(formData, "name"),
      description: text(formData, "description"),
      capability: text(formData, "capability"),
      billingUnit: text(formData, "billingUnit"),
      priceMinor,
    });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return { ok: true, message: "Offering added." };
}

export async function removeOfferingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await deleteOffering(actor, workspace.organization.id, text(formData, "offeringId"));
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true };
}

export async function submitListingAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await submitSellerListing(actor, workspace.organization.id);
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Submitted for activation." };
}

export async function withdrawListingAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await withdrawSellerListing(actor, workspace.organization.id);
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Returned to draft." };
}

/** Link the listing to an ERC-8004 agent id. Everything else is read from the chain. */
export async function linkIdentityAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let confirmed: boolean;
  try {
    const { actor, workspace } = await requireActionWorkspace();
    const saved = await linkSellerIdentity(actor, workspace.organization.id, {
      agentId: text(formData, "agentId"),
    });
    confirmed = saved.confirmed;
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return {
    ok: true,
    message: confirmed
      ? "Linked and confirmed by the agent's registration."
      : "Linked as an unconfirmed claim. See below for what confirms it.",
  };
}

export async function refreshIdentityAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await refreshOwnSellerIdentity(actor, workspace.organization.id);
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Read again from GOAT Testnet3." };
}

export async function unlinkIdentityAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await unlinkSellerIdentity(actor, workspace.organization.id);
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Identity unlinked." };
}
