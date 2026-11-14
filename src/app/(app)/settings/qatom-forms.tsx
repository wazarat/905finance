"use client";

import { useActionState } from "react";
import { FormMessage, SubmitButton } from "@/components/forms/field";
import { initialFormState } from "@/server/form-state";
import { connectQatomAction, disconnectQatomAction } from "./qatom-actions";

/** Starts the sign-in at Qatom. The owner signs in on Qatom's own pages. */
export function ConnectQatomForm({ label = "Connect Qatom" }: { label?: string }) {
  const [state, action] = useActionState(connectQatomAction, initialFormState);
  return (
    <form action={action} className="space-y-2">
      <SubmitButton pendingLabel="Opening Qatom…">{label}</SubmitButton>
      {state.message ? <FormMessage message={state.message} tone="error" /> : null}
    </form>
  );
}

export function DisconnectQatomForm() {
  const [state, action] = useActionState(disconnectQatomAction, initialFormState);
  return (
    <form action={action} className="space-y-2">
      <SubmitButton variant="outline" pendingLabel="Unlinking…">
        Unlink
      </SubmitButton>
      {state.message && !state.ok ? <FormMessage message={state.message} tone="error" /> : null}
    </form>
  );
}
