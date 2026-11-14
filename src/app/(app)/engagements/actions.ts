"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  authorizeEngagement,
  authorizeFunding,
  cancelEngagement,
  createEngagement,
  provisionEngagementWallet,
  saveMandateDraft,
} from "@/server/engagements";
import { isAppError } from "@/server/errors";
import {
  failureState,
  formValues,
  text,
  textList,
  type FormState,
} from "@/server/form-state";
import { requireActionWorkspace } from "@/server/page-context";

// Engagement ids arrive from the form, but every data-layer call checks that
// the signed-in user belongs to the engagement's organization and holds the
// role the action needs. The organization itself always comes from the session.

export async function createEngagementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let engagementId: string;
  try {
    const { actor, workspace } = await requireActionWorkspace();
    const engagement = await createEngagement(actor, workspace.organization.id, {
      sellerSlug: text(formData, "sellerSlug"),
      projectId: text(formData, "projectId"),
    });
    engagementId = engagement.id;
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  redirect(`/engagements/${engagementId}`);
}

export async function saveMandateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    const days = text(formData, "expiresInDays").trim();
    await saveMandateDraft(actor, text(formData, "engagementId"), {
      rail: text(formData, "rail"),
      totalBudget: text(formData, "totalBudget"),
      perTransactionLimit: text(formData, "perTransactionLimit"),
      offeringIds: textList(formData, "offeringIds"),
      scope: text(formData, "scope"),
      expiresInDays: /^\d{1,4}$/.test(days) ? Number(days) : undefined,
    });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return { ok: true, message: "Mandate saved. Nothing is authorized yet." };
}

/**
 * Authorizes the engagement, then provisions its wallet. If provisioning does
 * not go through, the authorization still stands and the page offers a retry.
 * Neither step moves funds.
 */
export async function authorizeEngagementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const engagementId = text(formData, "engagementId");
  let message = "Engagement authorized and wallet provisioned. No funds have moved.";
  try {
    const { actor } = await requireActionWorkspace();
    await authorizeEngagement(actor, engagementId, {
      confirmed: formData.get("confirmed") === "on",
    });
    try {
      await provisionEngagementWallet(actor, engagementId);
    } catch (error) {
      if (!isAppError(error)) throw error;
      message = "Engagement authorized. The wallet still needs to be provisioned.";
    }
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message };
}

export async function provisionWalletAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await provisionEngagementWallet(actor, text(formData, "engagementId"));
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Wallet provisioned." };
}

export async function authorizeFundingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let failed: string | null = null;
  try {
    const { actor } = await requireActionWorkspace();
    const outcome = await authorizeFunding(actor, text(formData, "engagementId"), {
      amount: text(formData, "amount"),
      idempotencyKey: text(formData, "idempotencyKey"),
      confirmed: formData.get("confirmed") === "on",
    });
    if (outcome.funding.status === "failed") {
      failed = outcome.funding.failureReason ?? "The transfer did not go through.";
    }
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  if (failed) {
    return { ok: false, message: `Funding failed and no funds moved: ${failed}` };
  }
  return { ok: true, message: "Funding authorized." };
}

export async function cancelEngagementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await cancelEngagement(actor, text(formData, "engagementId"));
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Engagement cancelled." };
}
