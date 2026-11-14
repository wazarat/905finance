"use server";

import { refresh } from "next/cache";
import { failureState, formValues, text, type FormState } from "@/server/form-state";
import { requireActionWorkspace } from "@/server/page-context";
import { depositSimulatedFunds } from "@/server/wallets";

export async function addSimulatedFundsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const { actor, workspace } = await requireActionWorkspace();
    await depositSimulatedFunds(actor, workspace.organization.id, {
      amount: text(formData, "amount"),
    });
  } catch (error) {
    return failureState(error, formValues(formData));
  }
  refresh();
  return { ok: true, message: "Simulated funds added." };
}
