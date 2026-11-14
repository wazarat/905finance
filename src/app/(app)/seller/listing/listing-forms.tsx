"use client";

import { useActionState } from "react";
import { Trash2 } from "lucide-react";
import {
  Field,
  FieldError,
  FormMessage,
  SubmitButton,
  controlClass,
} from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BILLING_UNIT_LABELS,
  CAPABILITIES,
  PAYMENT_RAILS,
  STANDARD_CAPABILITIES,
  WEB3_CAPABILITIES,
  type Capability,
} from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import { initialFormState, type FormState } from "@/server/form-state";
import {
  addOfferingAction,
  removeOfferingAction,
  saveEndpointAction,
  saveListingAction,
  submitListingAction,
  withdrawListingAction,
} from "./actions";

const checkCard =
  "flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background/40 p-3 transition-colors has-[:checked]:border-brand/60 has-[:checked]:bg-brand-dim has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring hover:border-brand/30";

function str(state: FormState, key: string, fallback: string): string {
  const v = state.values?.[key];
  return typeof v === "string" ? v : fallback;
}

function list(state: FormState, key: string, fallback: string[]): string[] {
  const v = state.values?.[key];
  if (v === undefined) return state.values ? [] : fallback;
  return Array.isArray(v) ? v : [v];
}

function Status({ state }: { state: FormState }) {
  if (!state.message) return null;
  return <FormMessage message={state.message} tone={state.ok ? "success" : "error"} />;
}

function CapabilityGroup({
  legend,
  capabilities,
  selected,
  disabled,
}: {
  legend: string;
  capabilities: Capability[];
  selected: string[];
  disabled: boolean;
}) {
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-xs text-muted-foreground">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {capabilities.map((capability) => (
          <label key={capability.key} className={checkCard}>
            <input
              type="checkbox"
              name="capabilities"
              value={capability.key}
              defaultChecked={selected.includes(capability.key)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">{capability.label}</span>
              <span className="block text-xs leading-relaxed text-muted-foreground">
                {capability.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export type ListingProfileValues = {
  displayName: string;
  tagline: string;
  description: string;
  capabilities: string[];
  intendedRails: string[];
};

export function ListingProfileForm({
  initial,
  canEdit,
}: {
  initial: ListingProfileValues;
  canEdit: boolean;
}) {
  const [state, action] = useActionState(saveListingAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  const failed = !state.ok && state.values !== undefined;
  const selectedCapabilities = failed ? list(state, "capabilities", []) : initial.capabilities;
  const selectedRails = failed ? list(state, "intendedRails", []) : initial.intendedRails;

  return (
    <form action={action} className="space-y-6" noValidate>
      <div className="grid gap-6 sm:grid-cols-2">
        <Field id="displayName" label="Seller name" errors={errors.displayName}>
          <Input
            id="displayName"
            name="displayName"
            required
            disabled={!canEdit}
            defaultValue={failed ? str(state, "displayName", "") : initial.displayName}
            aria-invalid={Boolean(errors.displayName)}
            className="h-10"
          />
        </Field>
        <Field
          id="tagline"
          label="Tagline"
          optional
          hint="One line shown on your marketplace card. Up to 140 characters."
          errors={errors.tagline}
        >
          <Input
            id="tagline"
            name="tagline"
            maxLength={140}
            disabled={!canEdit}
            defaultValue={failed ? str(state, "tagline", "") : initial.tagline}
            className="h-10"
          />
        </Field>
      </div>

      <Field
        id="description"
        label="Description"
        hint="What your agent does, how it reports results, and anything a buyer should know before engaging it."
        errors={errors.description}
      >
        <textarea
          id="description"
          name="description"
          rows={6}
          disabled={!canEdit}
          defaultValue={failed ? str(state, "description", "") : initial.description}
          className={cn(controlClass, "py-2.5")}
        />
      </Field>

      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium text-foreground">Agent capabilities</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Select what your agent can actually perform. Buyers filter by these.
          </p>
        </div>
        <CapabilityGroup
          legend="Conventional software"
          capabilities={STANDARD_CAPABILITIES}
          selected={selectedCapabilities}
          disabled={!canEdit}
        />
        <CapabilityGroup
          legend="Smart contracts and Web3"
          capabilities={WEB3_CAPABILITIES}
          selected={selectedCapabilities}
          disabled={!canEdit}
        />
        <FieldError id="capabilities-error" messages={errors.capabilities} />
      </div>

      <fieldset className="space-y-2" disabled={!canEdit}>
        <legend className="text-sm font-medium text-foreground">Payment rails you plan to accept</legend>
        <p className="text-xs text-muted-foreground">
          Shown to buyers as declared. Connecting a receiving account for each rail comes later and
          is required before any payment.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {PAYMENT_RAILS.map((rail) => (
            <label key={rail.key} className={checkCard}>
              <input
                type="checkbox"
                name="intendedRails"
                value={rail.key}
                defaultChecked={selectedRails.includes(rail.key)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">{rail.label}</span>
                <span className="block text-xs text-muted-foreground">{rail.asset}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton>Save listing</SubmitButton>
          <Status state={state} />
        </div>
      ) : null}
    </form>
  );
}

export function EndpointForm({
  initial,
  canEdit,
}: {
  initial: { url: string; protocol: string };
  canEdit: boolean;
}) {
  const [state, action] = useActionState(saveEndpointAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  const failed = !state.ok && state.values !== undefined;
  return (
    <form action={action} className="space-y-5" noValidate>
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <Field
          id="endpoint-url"
          label="Endpoint URL"
          hint="Private. Never shown on your public listing; shared only with a buyer's agent after an authorized engagement."
          errors={errors.url}
        >
          <Input
            id="endpoint-url"
            name="url"
            type="url"
            inputMode="url"
            placeholder="https://agent.your-domain.com/api"
            disabled={!canEdit}
            defaultValue={failed ? str(state, "url", "") : initial.url}
            aria-invalid={Boolean(errors.url)}
            className="h-10"
          />
        </Field>
        <Field id="endpoint-protocol" label="Protocol" errors={errors.protocol}>
          <select
            id="endpoint-protocol"
            name="protocol"
            disabled={!canEdit}
            key={failed ? str(state, "protocol", "https_json") : initial.protocol}
            defaultValue={failed ? str(state, "protocol", "https_json") : initial.protocol}
            className={cn(controlClass, "h-10")}
          >
            <option value="https_json">HTTPS / JSON</option>
            <option value="mcp">MCP</option>
            <option value="a2a">Agent-to-agent (A2A)</option>
          </select>
        </Field>
      </div>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton variant="outline">Save endpoint</SubmitButton>
          <Status state={state} />
        </div>
      ) : null}
    </form>
  );
}

function AddOfferingFields({ state }: { state: FormState }) {
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="offering-name" label="Service name" errors={errors.name}>
          <Input
            id="offering-name"
            name="name"
            placeholder="e.g. Unit test run"
            defaultValue={str(state, "name", "")}
            aria-invalid={Boolean(errors.name)}
            className="h-10"
          />
        </Field>
        <Field id="offering-capability" label="Capability" errors={errors.capability}>
          <select
            id="offering-capability"
            name="capability"
            // Keyed so the echoed value is re-applied when the form resets after submit.
            key={str(state, "capability", "")}
            defaultValue={str(state, "capability", "")}
            aria-invalid={Boolean(errors.capability)}
            className={cn(controlClass, "h-10")}
          >
            <option value="">Choose…</option>
            {CAPABILITIES.map((capability) => (
              <option key={capability.key} value={capability.key}>
                {capability.label}
                {capability.web3 ? " (Web3)" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field id="offering-description" label="Description" optional errors={errors.description}>
        <Input
          id="offering-description"
          name="description"
          placeholder="What the buyer gets for one unit"
          defaultValue={str(state, "description", "")}
          className="h-10"
        />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="offering-price"
          label="Price (USD)"
          hint="Per billing unit."
          errors={errors.price ?? errors.priceMinor}
        >
          <div className="relative">
            <span
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground"
              aria-hidden="true"
            >
              $
            </span>
            <Input
              id="offering-price"
              name="price"
              inputMode="decimal"
              placeholder="25.00"
              defaultValue={str(state, "price", "")}
              aria-invalid={Boolean(errors.price ?? errors.priceMinor)}
              className="figure h-10 pl-7"
            />
          </div>
        </Field>
        <Field id="offering-unit" label="Billing unit" errors={errors.billingUnit}>
          <select
            id="offering-unit"
            name="billingUnit"
            key={str(state, "billingUnit", "per_run")}
            defaultValue={str(state, "billingUnit", "per_run")}
            className={cn(controlClass, "h-10")}
          >
            {Object.entries(BILLING_UNIT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </>
  );
}

/**
 * A successful add returns no echoed values, so the fields come back empty for
 * the next offering; a failed add echoes what was typed so nothing is lost.
 */
export function AddOfferingForm() {
  const [state, action] = useActionState(addOfferingAction, initialFormState);
  return (
    <form action={action} className="space-y-5" noValidate>
      <AddOfferingFields state={state} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="outline" pendingLabel="Adding…">
          Add offering
        </SubmitButton>
        <Status state={state} />
      </div>
    </form>
  );
}

export function RemoveOfferingButton({ offeringId, name }: { offeringId: string; name: string }) {
  const [state, action, pending] = useActionState(removeOfferingAction, initialFormState);
  return (
    <form action={action}>
      <input type="hidden" name="offeringId" value={offeringId} />
      <Button
        type="submit"
        variant="ghost"
        size="icon-lg"
        disabled={pending}
        aria-label={`Remove ${name}`}
        title={!state.ok && state.message ? state.message : `Remove ${name}`}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </form>
  );
}

export function SubmitListingForm({ ready }: { ready: boolean }) {
  const [state, action] = useActionState(submitListingAction, initialFormState);
  const gaps = !state.ok ? state.fieldErrors?._form : undefined;
  return (
    <form action={action} className="space-y-3">
      <SubmitButton disabled={!ready} pendingLabel="Submitting…">
        Submit for activation
      </SubmitButton>
      {gaps ? (
        <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-destructive">
          {gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      ) : (
        <Status state={state} />
      )}
    </form>
  );
}

export function WithdrawListingForm() {
  const [state, action] = useActionState(withdrawListingAction, initialFormState);
  return (
    <form action={action} className="space-y-3">
      <SubmitButton variant="outline" pendingLabel="Withdrawing…">
        Withdraw and edit
      </SubmitButton>
      <Status state={state} />
    </form>
  );
}
