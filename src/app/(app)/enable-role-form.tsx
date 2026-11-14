"use client";

import { useActionState } from "react";
import { FormMessage, SubmitButton } from "@/components/forms/field";
import { initialFormState } from "@/server/form-state";
import { enableRoleAction } from "./role-actions";

export function EnableRoleForm({ role, label }: { role: "buyer" | "seller"; label: string }) {
  const [state, action] = useActionState(enableRoleAction, initialFormState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="role" value={role} />
      <SubmitButton pendingLabel="Enabling…">{label}</SubmitButton>
      {!state.ok && state.message ? <FormMessage message={state.message} /> : null}
    </form>
  );
}
