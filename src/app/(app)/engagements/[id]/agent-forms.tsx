"use client";

import { useActionState, useState } from "react";
import {
  Field,
  FieldError,
  FormMessage,
  SubmitButton,
  controlClass,
} from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { initialFormState, type FormState } from "@/server/form-state";
import {
  approveBudgetAction,
  modifyWorkAction,
  reconcilePurchaseAction,
  rejectApprovalAction,
  runAgentAction,
} from "../actions";

function Status({ state }: { state: FormState }) {
  if (!state.message) return null;
  return <FormMessage message={state.message} tone={state.ok ? "success" : "error"} />;
}

/** Starts one run of the agent. The key makes a double submit start one run, not two. */
export function RunAgentForm({ engagementId, runKey }: { engagementId: string; runKey: string }) {
  const [state, action] = useActionState(runAgentAction, initialFormState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="engagementId" value={engagementId} />
      <input type="hidden" name="runKey" value={runKey} />
      <SubmitButton pendingLabel="Agent is working…">Run agent</SubmitButton>
      <Status state={state} />
    </form>
  );
}

type Decision = "approve" | "modify" | "decline";

/**
 * The buyer's choices on a budget request: approve a higher total, have the
 * agent do different permitted work, or decline. Ending the engagement is the
 * separate cancel control further down the page.
 */
export function BudgetDecisionForms({
  approvalId,
  assetCode,
  minimumTotal,
  currentTotalLabel,
  alternatives,
}: {
  approvalId: string;
  assetCode: string;
  minimumTotal: string;
  currentTotalLabel: string;
  alternatives: Array<{ id: string; label: string }>;
}) {
  const [decision, setDecision] = useState<Decision>("approve");
  const [approveState, approve] = useActionState(approveBudgetAction, initialFormState);
  const [modifyState, modify] = useActionState(modifyWorkAction, initialFormState);
  const [declineState, decline] = useActionState(rejectApprovalAction, initialFormState);
  const approveErrors = approveState.ok ? {} : (approveState.fieldErrors ?? {});
  const modifyErrors = modifyState.ok ? {} : (modifyState.fieldErrors ?? {});
  const echoedTotal =
    !approveState.ok && typeof approveState.values?.newTotal === "string"
      ? approveState.values.newTotal
      : minimumTotal;

  const tabs: Array<{ key: Decision; label: string }> = [
    { key: "approve", label: "Approve a higher budget" },
    { key: "modify", label: "Change the work" },
    { key: "decline", label: "Decline" },
  ];

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Your decision" className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={decision === tab.key}
            onClick={() => setDecision(tab.key)}
            className={cn(
              "rounded-lg border px-3 py-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              decision === tab.key
                ? "border-brand bg-brand-dim font-medium text-foreground"
                : "border-border text-muted-foreground hover:border-brand/40 hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {decision === "approve" ? (
        <form action={approve} className="space-y-4" noValidate>
          <input type="hidden" name="approvalId" value={approvalId} />
          <Field
            id="newTotal"
            label={`New total budget (${assetCode})`}
            hint={`Currently ${currentTotalLabel}. The proposed work needs at least ${minimumTotal} ${assetCode}.`}
            errors={approveErrors.newTotal}
            className="sm:max-w-xs"
          >
            <Input
              id="newTotal"
              name="newTotal"
              inputMode="decimal"
              defaultValue={echoedTotal}
              aria-invalid={Boolean(approveErrors.newTotal)}
              className="figure h-10"
            />
          </Field>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-background/40 p-4 has-[:checked]:border-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
            <input type="checkbox" name="confirmed" className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
            <span className="text-sm leading-relaxed text-ink-soft">
              <span className="font-medium text-foreground">I approve this higher total budget.</span>{" "}
              It raises what the agent may spend. It moves no funds into the wallet and does not
              change the permitted services, the scope or the per-purchase limit.
            </span>
          </label>
          <FieldError id="confirmed-error" messages={approveErrors.confirmed} />
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pendingLabel="Approving…">Approve budget</SubmitButton>
            {approveErrors.newTotal || approveErrors.confirmed ? null : <Status state={approveState} />}
          </div>
        </form>
      ) : null}

      {decision === "modify" ? (
        alternatives.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None of the other permitted services fits the remaining budget and funds.
          </p>
        ) : (
          <form action={modify} className="space-y-4">
            <input type="hidden" name="approvalId" value={approvalId} />
            <Field
              id="replacementOfferingId"
              label="Do this instead"
              hint="Only permitted services that fit the limits already in place are listed. Nothing about the mandate changes."
              errors={modifyErrors.replacementOfferingId}
              className="sm:max-w-md"
            >
              <select
                id="replacementOfferingId"
                name="replacementOfferingId"
                className={cn(controlClass, "h-10")}
                defaultValue={alternatives[0]?.id}
              >
                {alternatives.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <SubmitButton variant="outline" pendingLabel="Saving…">
                Change the work
              </SubmitButton>
              {modifyErrors.replacementOfferingId ? null : <Status state={modifyState} />}
            </div>
          </form>
        )
      ) : null}

      {decision === "decline" ? (
        <form action={decline} className="space-y-4">
          <input type="hidden" name="approvalId" value={approvalId} />
          <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
            The budget stays as it is and the engagement resumes. The agent will only buy what
            still fits, and will not ask again.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton variant="outline" pendingLabel="Declining…">
              Decline the increase
            </SubmitButton>
            <Status state={declineState} />
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** Declines a funding request. Approving one is done by authorizing funding. */
export function DeclineFundingForm({ approvalId }: { approvalId: string }) {
  const [state, action] = useActionState(rejectApprovalAction, initialFormState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="approvalId" value={approvalId} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="outline" pendingLabel="Declining…">
          Decline, add no funds
        </SubmitButton>
        <Status state={state} />
      </div>
    </form>
  );
}

export function ReconcileButton({ purchaseId }: { purchaseId: string }) {
  const [state, action, pending] = useActionState(reconcilePurchaseAction, initialFormState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="purchaseId" value={purchaseId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Checking…" : "Check payment status"}
      </Button>
      <Status state={state} />
    </form>
  );
}
