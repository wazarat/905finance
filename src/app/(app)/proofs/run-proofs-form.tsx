"use client";

import { useActionState } from "react";
import { FormMessage, SubmitButton } from "@/components/forms/field";
import { initialFormState } from "@/server/form-state";
import { runProofsAction } from "./actions";

export function RunProofsForm({ label = "Write waiting proofs to GOAT" }: { label?: string }) {
  const [state, action] = useActionState(runProofsAction, initialFormState);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <SubmitButton variant="outline" pendingLabel="Writing…">
        {label}
      </SubmitButton>
      {state.message ? <FormMessage message={state.message} tone={state.ok ? "success" : "error"} /> : null}
    </form>
  );
}
