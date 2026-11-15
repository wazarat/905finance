"use client";

import { useActionState } from "react";
import { FieldError, FormMessage, SubmitButton } from "@/components/forms/field";
import { Input } from "@/components/ui/input";
import { initialFormState } from "@/server/form-state";
import { addSimulatedFundsAction } from "./actions";

/** Adds simulated funds to one rail's master account. Clearly not real money. */
export function AddSimulatedFundsForm({ rail, assetCode }: { rail: string; assetCode: string }) {
  const [state, action] = useActionState(addSimulatedFundsAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  const id = `add-funds-${rail}`;
  return (
    <form action={action} className="space-y-2" noValidate>
      <input type="hidden" name="rail" value={rail} />
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Add funds ({assetCode})
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          name="amount"
          inputMode="decimal"
          placeholder="1000.00"
          defaultValue={!state.ok && typeof state.values?.amount === "string" ? state.values.amount : ""}
          aria-invalid={Boolean(errors.amount)}
          className="figure h-10 max-w-40"
        />
        <SubmitButton variant="outline" pendingLabel="Adding…">
          Add
        </SubmitButton>
      </div>
      <p className="text-xs text-muted-foreground">A test balance. No card or bank account is charged.</p>
      <FieldError id={`${id}-error`} messages={errors.amount} />
      {state.message && !errors.amount ? (
        <FormMessage message={state.message} tone={state.ok ? "success" : "error"} />
      ) : null}
    </form>
  );
}
