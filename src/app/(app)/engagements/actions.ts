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
import { runAgent } from "@/server/agent/runtime";
import { approveBudgetIncrease, modifyProposedWork, rejectApproval } from "@/server/approvals";
import { isAppError } from "@/server/errors";
import { reconcilePurchase } from "@/server/policy";
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
      transactionHash: text(formData, "transactionHash") || undefined,
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

/**
 * Starts the purchasing agent for an engagement. The run is carried out on the
 * server inside the mandate; the form only says which engagement to run.
 */
export async function runAgentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let summary: string;
  let ok: boolean;
  try {
    const { actor } = await requireActionWorkspace();
    const { run } = await runAgent(actor, text(formData, "engagementId"), {
      runKey: text(formData, "runKey"),
    });
    summary = run.summary;
    ok = run.status !== "failed";
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok, message: summary };
}

export async function approveBudgetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await approveBudgetIncrease(actor, text(formData, "approvalId"), {
      newTotal: text(formData, "newTotal"),
      confirmed: formData.get("confirmed") === "on",
    });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return { ok: true, message: "Budget increased. No funds were moved." };
}

export async function rejectApprovalAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await rejectApproval(actor, text(formData, "approvalId"));
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Request declined. Limits are unchanged." };
}

export async function modifyWorkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await modifyProposedWork(actor, text(formData, "approvalId"), {
      replacementOfferingId: text(formData, "replacementOfferingId"),
    });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return { ok: true, message: "The agent will do that instead. Limits are unchanged." };
}

export async function reconcilePurchaseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let status: string;
  try {
    const { actor } = await requireActionWorkspace();
    const purchase = await reconcilePurchase(actor, text(formData, "purchaseId"));
    status = purchase.status;
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return {
    ok: status !== "needs_reconciliation",
    message:
      status === "paid"
        ? "The payment was confirmed."
        : status === "payment_failed"
          ? "The payment did not go through. Nothing was charged."
          : "The provider still cannot say what happened.",
  };
}
