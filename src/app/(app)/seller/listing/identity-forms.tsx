"use client";

import { useActionState } from "react";
import { Field, FormMessage, SubmitButton } from "@/components/forms/field";
import { Input } from "@/components/ui/input";
import { initialFormState } from "@/server/form-state";
import { linkIdentityAction, refreshIdentityAction, unlinkIdentityAction } from "./actions";

/** Takes an agent id and nothing else: the rest is read from the chain. */
export function LinkIdentityForm({ currentAgentId }: { currentAgentId: string | null }) {
  const [state, action] = useActionState(linkIdentityAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  const echoed = !state.ok && typeof state.values?.agentId === "string" ? state.values.agentId : null;
  return (
    <form action={action} className="space-y-3" noValidate>
      <Field
        id="agentId"
        label="Agent id"
        hint="The number the ERC-8004 Identity Registry on GOAT Testnet3 gave your agent when you registered it."
        errors={errors.agentId}
      >
        <Input
          id="agentId"
          name="agentId"
          inputMode="numeric"
          placeholder="42"
          defaultValue={echoed ?? currentAgentId ?? ""}
          aria-invalid={Boolean(errors.agentId)}
          className="figure h-10 max-w-40"
        />
      </Field>
      <SubmitButton pendingLabel="Reading GOAT…">{currentAgentId ? "Change agent" : "Link agent"}</SubmitButton>
      {state.message && !errors.agentId ? (
        <FormMessage message={state.message} tone={state.ok ? "success" : "error"} />
      ) : null}
    </form>
  );
}

export function IdentityControls() {
  const [refreshed, refreshAction] = useActionState(refreshIdentityAction, initialFormState);
  const [unlinked, unlinkAction] = useActionState(unlinkIdentityAction, initialFormState);
  const message = refreshed.message ?? unlinked.message;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        <form action={refreshAction}>
          <SubmitButton variant="outline" pendingLabel="Reading GOAT…">
            Read again
          </SubmitButton>
        </form>
        <form action={unlinkAction}>
          <SubmitButton variant="ghost" pendingLabel="Unlinking…">
            Unlink
          </SubmitButton>
        </form>
      </div>
      {message ? <FormMessage message={message} tone={refreshed.ok || unlinked.ok ? "success" : "error"} /> : null}
    </div>
  );
}
