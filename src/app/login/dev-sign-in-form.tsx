"use client";

import { useActionState } from "react";
import { Field, FormMessage, SubmitButton } from "@/components/forms/field";
import { Input } from "@/components/ui/input";
import { initialFormState } from "@/server/form-state";
import { devSignIn } from "./actions";

export function DevSignInForm({ next }: { next: string }) {
  const [state, action] = useActionState(devSignIn, initialFormState);
  const email = typeof state.values?.email === "string" ? state.values.email : "";
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <Field id="dev-email" label="Email" errors={state.fieldErrors?.email}>
        <Input
          id="dev-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          defaultValue={email}
          placeholder="you@example.com"
          aria-invalid={Boolean(state.fieldErrors?.email)}
          aria-describedby={state.fieldErrors?.email ? "dev-email-error" : undefined}
          className="h-10"
        />
      </Field>
      {state.message && !state.fieldErrors?.email ? <FormMessage message={state.message} /> : null}
      <SubmitButton pendingLabel="Signing in…" variant="outline" className="w-full">
        Sign in for development
      </SubmitButton>
    </form>
  );
}
