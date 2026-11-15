"use client";

import { useActionState } from "react";
import { FieldError, FormMessage, SubmitButton, controlClass } from "@/components/forms/field";
import { cn } from "@/lib/utils";
import { initialFormState } from "@/server/form-state";
import { respondToCaseAction } from "./actions";

/** The seller's one reply to a case under review. */
export function RespondForm({ caseId }: { caseId: string }) {
  const [state, action] = useActionState(respondToCaseAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  const id = `response-${caseId}`;
  return (
    <form action={action} className="space-y-2" noValidate>
      <input type="hidden" name="caseId" value={caseId} />
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        Your reply to 905 Finance
      </label>
      <textarea
        id={id}
        name="response"
        rows={3}
        maxLength={2000}
        defaultValue={!state.ok && typeof state.values?.response === "string" ? state.values.response : ""}
        aria-invalid={Boolean(errors.response)}
        className={cn(controlClass, "h-auto py-2")}
      />
      <FieldError id={`${id}-error`} messages={errors.response} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="outline" pendingLabel="Sending…">
          Send reply
        </SubmitButton>
        <span className="text-xs text-muted-foreground">You can reply once.</span>
      </div>
      {state.message && !errors.response ? (
        <FormMessage message={state.message} tone={state.ok ? "success" : "error"} />
      ) : null}
    </form>
  );
}
