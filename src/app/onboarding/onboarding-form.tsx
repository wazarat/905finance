"use client";

import { useActionState, useState } from "react";
import { Field, FieldError, FormMessage, SubmitButton } from "@/components/forms/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { initialFormState } from "@/server/form-state";
import { submitOnboarding } from "./actions";

const ROLES = [
  {
    value: "buyer",
    title: "Buyer",
    body: "Hire agents to test your software. Create projects, pick sellers and control budgets.",
  },
  {
    value: "seller",
    title: "Seller",
    body: "List an agent's services with per-use pricing and receive authorized purchases.",
  },
  {
    value: "both",
    title: "Both",
    body: "Buy and sell from one account. You can also add the other role later.",
  },
] as const;

const ACCOUNT_TYPES = [
  { value: "business", label: "Business or team" },
  { value: "individual", label: "Individual" },
] as const;

const choiceCard =
  "flex h-full cursor-pointer flex-col rounded-xl border border-border bg-card p-4 transition-colors has-[:checked]:border-brand has-[:checked]:bg-brand-dim has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring hover:border-brand/40";

function value(values: Record<string, string | string[]> | undefined, key: string, fallback = "") {
  const v = values?.[key];
  return typeof v === "string" ? v : fallback;
}

export function OnboardingForm({ defaultName }: { defaultName: string }) {
  const [state, action] = useActionState(submitOnboarding, initialFormState);
  const [roles, setRoles] = useState(value(state.values, "roles", "buyer"));
  const errors = state.fieldErrors ?? {};
  const sells = roles === "seller" || roles === "both";

  return (
    <form action={action} className="space-y-10" noValidate>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-foreground">How will you use 905 Finance?</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {ROLES.map((role) => (
            <label key={role.value} className={choiceCard}>
              <input
                type="radio"
                name="roles"
                value={role.value}
                checked={roles === role.value}
                onChange={() => setRoles(role.value)}
                className="sr-only"
              />
              <span className="font-medium text-foreground">{role.title}</span>
              <span className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{role.body}</span>
            </label>
          ))}
        </div>
        <FieldError id="roles-error" messages={errors.roles} />
      </fieldset>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field id="displayName" label="Your name" errors={errors.displayName}>
          <Input
            id="displayName"
            name="displayName"
            autoComplete="name"
            required
            defaultValue={value(state.values, "displayName", defaultName)}
            aria-invalid={Boolean(errors.displayName)}
            className="h-10"
          />
        </Field>
        <Field
          id="organizationName"
          label="Organization name"
          hint="Projects, engagements and wallets belong to the organization. You'll be its owner."
          errors={errors.organizationName}
        >
          <Input
            id="organizationName"
            name="organizationName"
            autoComplete="organization"
            required
            defaultValue={value(state.values, "organizationName")}
            aria-invalid={Boolean(errors.organizationName)}
            className="h-10"
          />
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-foreground">Account type</legend>
        <div className="flex flex-wrap gap-3">
          {ACCOUNT_TYPES.map((type, index) => (
            <label
              key={type.value}
              className={cn(choiceCard, "h-auto flex-row items-center px-4 py-2.5 text-sm text-foreground")}
            >
              <input
                type="radio"
                name="accountType"
                value={type.value}
                defaultChecked={
                  value(state.values, "accountType")
                    ? value(state.values, "accountType") === type.value
                    : index === 0
                }
                className="sr-only"
              />
              {type.label}
            </label>
          ))}
        </div>
        <FieldError id="accountType-error" messages={errors.accountType} />
      </fieldset>

      {sells ? (
        <Field
          id="sellerDisplayName"
          label="Seller name"
          optional
          hint="The name buyers see on your listing. Defaults to your organization name; you can change it before publishing."
          errors={errors.sellerDisplayName}
        >
          <Input
            id="sellerDisplayName"
            name="sellerDisplayName"
            defaultValue={value(state.values, "sellerDisplayName")}
            className="h-10 sm:max-w-sm"
          />
        </Field>
      ) : null}

      {state.message && Object.keys(errors).length === 0 ? <FormMessage message={state.message} /> : null}

      <SubmitButton pendingLabel="Creating your workspace…" className="h-11 px-5 text-[0.95rem]">
        Create workspace
      </SubmitButton>
    </form>
  );
}
