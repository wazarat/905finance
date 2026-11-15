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
import { checkFundReturn, completeEngagement, returnUnusedFunds } from "@/server/closure";
import { requireActionWorkspace } from "@/server/page-context";
import { checkRatingOnChain, rateEngagement, reportProblem } from "@/server/reputation";

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

/** The owner declares the engagement's work done. Final. */
export async function completeEngagementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await completeEngagement(actor, text(formData, "engagementId"));
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return { ok: true, message: "Engagement completed." };
}

/** The owner authorizes sending an ended engagement's unused funds back where they came from. */
export async function returnFundsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let outcome: { status: string; failureReason: string | null };
  try {
    const { actor } = await requireActionWorkspace();
    outcome = await returnUnusedFunds(actor, text(formData, "engagementId"), {
      idempotencyKey: text(formData, "idempotencyKey"),
      confirmed: formData.get("confirmed") === "on",
    });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  if (outcome.status === "executed") return { ok: true, message: "Unused funds returned." };
  if (outcome.status === "sent") {
    return { ok: true, message: "The transfer was sent and is waiting for the chain to confirm it." };
  }
  return { ok: false, message: outcome.failureReason ?? "The funds were not returned." };
}

/** Look again at a return that was sent but not yet confirmed. Sends nothing. */
export async function checkFundReturnAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let status: string | null;
  try {
    const { actor } = await requireActionWorkspace();
    status = (await checkFundReturn(actor, text(formData, "engagementId")))?.status ?? null;
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return status === "executed"
    ? { ok: true, message: "The return is confirmed." }
    : { ok: true, message: "Not confirmed yet. Nothing was sent again." };
}

/** Rate the seller for an engagement, once. */
export async function rateEngagementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let reviewed: boolean;
  try {
    const { actor } = await requireActionWorkspace();
    const saved = await rateEngagement(actor, text(formData, "engagementId"), {
      stars: text(formData, "stars"),
      comment: text(formData, "comment"),
    });
    reviewed = Boolean(saved.caseOpened);
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return {
    ok: true,
    message: reviewed ? "Rating saved, and sent to 905 Finance for review." : "Rating saved.",
  };
}

/** Put a problem with an engagement to 905 Finance. */
export async function reportProblemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor } = await requireActionWorkspace();
    await reportProblem(actor, text(formData, "engagementId"), { reason: text(formData, "reason") });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return { ok: true, message: "Sent to 905 Finance for review." };
}

/** Look again at a rating that was sent to the registry and not yet confirmed. Sends nothing. */
export async function checkRatingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let status: string | null;
  try {
    const { actor } = await requireActionWorkspace();
    status = (await checkRatingOnChain(actor, text(formData, "engagementId")))?.chainStatus ?? null;
  } catch (error) {
    return failureState(error);
  }
  refresh();
  return status === "confirmed"
    ? { ok: true, message: "Confirmed in the Reputation Registry." }
    : { ok: false, message: "Not confirmed yet." };
}
