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
  authorizeEngagementAction,
  authorizeFundingAction,
  cancelEngagementAction,
  provisionWalletAction,
  saveMandateAction,
} from "../actions";

const checkCard =
  "flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background/40 p-3 transition-colors has-[:checked]:border-brand/60 has-[:checked]:bg-brand-dim has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring hover:border-brand/30";

const confirmCard =
  "flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-background/40 p-4 has-[:checked]:border-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring";

function Status({ state }: { state: FormState }) {
  if (!state.message) return null;
  return <FormMessage message={state.message} tone={state.ok ? "success" : "error"} />;
}

function echoed(state: FormState, key: string, fallback: string): string {
  if (state.ok) return fallback;
  const value = state.values?.[key];
  return typeof value === "string" ? value : fallback;
}

export type MandateFormOffering = { id: string; name: string; priceLabel: string; detail: string };
export type MandateFormValues = {
  totalBudget: string;
  perTransactionLimit: string;
  offeringIds: string[];
  scope: string;
  expiresInDays: string;
};

/** Edits the draft mandate. Saving it authorizes nothing. */
export function MandateForm({
  engagementId,
  assetCode,
  offerings,
  initial,
}: {
  engagementId: string;
  /** The asset payments are made in. Fixed by the settlement network, not chosen here. */
  assetCode: string;
  offerings: MandateFormOffering[];
  initial: MandateFormValues;
}) {
  const [state, action] = useActionState(saveMandateAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  const failed = !state.ok && state.values !== undefined;

  const echoedOfferings = state.values?.offeringIds;
  const selected = failed
    ? Array.isArray(echoedOfferings)
      ? echoedOfferings
      : typeof echoedOfferings === "string"
        ? [echoedOfferings]
        : []
    : initial.offeringIds;

  return (
    <form action={action} className="space-y-8" noValidate>
      <input type="hidden" name="engagementId" value={engagementId} />

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          id="totalBudget"
          label={`Total budget${assetCode ? ` (${assetCode})` : ""}`}
          hint="The most the agent may spend across the whole engagement."
          errors={errors.totalBudget}
        >
          <Input
            id="totalBudget"
            name="totalBudget"
            inputMode="decimal"
            defaultValue={echoed(state, "totalBudget", initial.totalBudget)}
            aria-invalid={Boolean(errors.totalBudget)}
            className="figure h-10"
          />
        </Field>
        <Field
          id="perTransactionLimit"
          label={`Per-purchase limit${assetCode ? ` (${assetCode})` : ""}`}
          hint="The most any single purchase may cost."
          errors={errors.perTransactionLimit}
        >
          <Input
            id="perTransactionLimit"
            name="perTransactionLimit"
            inputMode="decimal"
            defaultValue={echoed(state, "perTransactionLimit", initial.perTransactionLimit)}
            aria-invalid={Boolean(errors.perTransactionLimit)}
            className="figure h-10"
          />
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-foreground">Services the agent may buy</legend>
        <p className="text-xs text-muted-foreground">
          The agent can purchase only what you tick here, and only from this seller.
        </p>
        {offerings.length === 0 ? (
          <p className="text-sm text-muted-foreground">This seller has no services on offer right now.</p>
        ) : (
          <div className="grid gap-2">
            {offerings.map((offering) => (
              <label key={offering.id} className={checkCard}>
                <input
                  type="checkbox"
                  name="offeringIds"
                  value={offering.id}
                  defaultChecked={selected.includes(offering.id)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{offering.name}</span>
                    <span className="block text-xs text-muted-foreground">{offering.detail}</span>
                  </span>
                  <span className="figure shrink-0 text-sm text-ink-soft">{offering.priceLabel}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        <FieldError id="offeringIds-error" messages={errors.offeringIds} />
      </fieldset>

      <Field
        id="scope"
        label="Testing scope"
        hint="What the agent is authorized to have tested. Raising the budget later never widens this."
        errors={errors.scope}
      >
        <textarea
          id="scope"
          name="scope"
          rows={4}
          defaultValue={echoed(state, "scope", initial.scope)}
          aria-invalid={Boolean(errors.scope)}
          className={cn(controlClass, "py-2.5")}
        />
      </Field>

      <Field
        id="expiresInDays"
        label="Expires after (days)"
        hint="Counted from when you save. After this the agent can buy nothing more."
        errors={errors.expiresInDays}
        className="sm:max-w-xs"
      >
        <Input
          id="expiresInDays"
          name="expiresInDays"
          inputMode="numeric"
          defaultValue={echoed(state, "expiresInDays", initial.expiresInDays)}
          aria-invalid={Boolean(errors.expiresInDays)}
          className="figure h-10"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="outline">Save mandate</SubmitButton>
        <Status state={state} />
      </div>
    </form>
  );
}

/** The buyer's explicit authorization. A ticked box plus a button; it moves no funds. */
export function AuthorizeEngagementForm({
  engagementId,
  sellerName,
  totalLabel,
  perPurchaseLabel,
  expiresLabel,
}: {
  engagementId: string;
  sellerName: string;
  totalLabel: string;
  perPurchaseLabel: string;
  expiresLabel: string;
}) {
  const [state, action] = useActionState(authorizeEngagementAction, initialFormState);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="engagementId" value={engagementId} />
      <label className={confirmCard}>
        <input
          type="checkbox"
          name="confirmed"
          className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
        />
        <span className="text-sm leading-relaxed text-ink-soft">
          <span className="font-medium text-foreground">
            I authorize this engagement with {sellerName}.
          </span>{" "}
          A purchasing agent may spend up to {totalLabel} in total and {perPurchaseLabel} per
          purchase, on the services and scope above, until {expiresLabel}. This creates the
          engagement&apos;s wallet but does not fund it.
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Authorizing…">Authorize engagement</SubmitButton>
        <Status state={state} />
      </div>
    </form>
  );
}

export function ProvisionWalletForm({ engagementId }: { engagementId: string }) {
  const [state, action] = useActionState(provisionWalletAction, initialFormState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="engagementId" value={engagementId} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Provisioning…">Provision wallet</SubmitButton>
        <Status state={state} />
      </div>
    </form>
  );
}

/**
 * Authorizes one transfer from the master account into this engagement's
 * wallet. The key identifies this one authorization, so pressing the button
 * twice cannot fund twice; the server issues a fresh key after each attempt.
 */
export function FundingForm({
  engagementId,
  idempotencyKey,
  assetCode,
  availableLabel,
  suggestedAmount,
  submitLabel,
}: {
  engagementId: string;
  idempotencyKey: string;
  assetCode: string;
  availableLabel: string;
  suggestedAmount: string;
  submitLabel: string;
}) {
  const [state, action] = useActionState(authorizeFundingAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="engagementId" value={engagementId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field
        id="funding-amount"
        label={`Amount (${assetCode})`}
        hint={`${availableLabel} available in the master account.`}
        errors={errors.amount}
        className="sm:max-w-xs"
      >
        <Input
          id="funding-amount"
          name="amount"
          inputMode="decimal"
          defaultValue={echoed(state, "amount", suggestedAmount)}
          aria-invalid={Boolean(errors.amount)}
          className="figure h-10"
        />
      </Field>
      <label className={confirmCard}>
        <input
          type="checkbox"
          name="confirmed"
          className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
        />
        <span className="text-sm leading-relaxed text-ink-soft">
          <span className="font-medium text-foreground">
            I authorize moving this amount from the master account into this engagement&apos;s
            wallet.
          </span>{" "}
          It can be spent only under this engagement&apos;s mandate.
        </span>
      </label>
      <FieldError id="confirmed-error" messages={errors.confirmed} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Authorizing…">{submitLabel}</SubmitButton>
        {errors.amount || errors.confirmed ? null : <Status state={state} />}
      </div>
    </form>
  );
}

/**
 * Funding a real wallet. The buyer sends the transfer themselves, from their
 * own wallet; this form records the transaction so the platform can confirm
 * it on the chain. The platform cannot send it for them.
 */
export function ChainFundingForm({
  engagementId,
  idempotencyKey,
  assetCode,
  walletAddress,
  fundingWallet,
  suggestedAmount,
  submitLabel,
}: {
  engagementId: string;
  idempotencyKey: string;
  assetCode: string;
  walletAddress: string;
  fundingWallet: string | null;
  suggestedAmount: string;
  submitLabel: string;
}) {
  const [state, action] = useActionState(authorizeFundingAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="engagementId" value={engagementId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <ol className="space-y-2 text-sm leading-relaxed text-ink-soft">
        <li>
          <span className="font-medium text-foreground">1. Send {assetCode}</span> on GOAT Testnet3 from{" "}
          {fundingWallet ? (
            <>
              your funding wallet <span className="figure break-all text-foreground">{fundingWallet}</span>
            </>
          ) : (
            "your own wallet"
          )}{" "}
          to this engagement&apos;s wallet:
          <span className="figure mt-1 block break-all text-foreground">{walletAddress}</span>
        </li>
        <li>
          <span className="font-medium text-foreground">2. Enter the amount and the transaction hash</span>{" "}
          below. The amount is credited once the chain confirms exactly that transfer.
        </li>
      </ol>
      <div className="grid gap-5 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <Field id="funding-amount" label={`Amount sent (${assetCode})`} errors={errors.amount}>
          <Input
            id="funding-amount"
            name="amount"
            inputMode="decimal"
            defaultValue={echoed(state, "amount", suggestedAmount)}
            aria-invalid={Boolean(errors.amount)}
            className="figure h-10"
          />
        </Field>
        <Field id="funding-hash" label="Transaction hash" errors={errors.transactionHash}>
          <Input
            id="funding-hash"
            name="transactionHash"
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
            defaultValue={echoed(state, "transactionHash", "")}
            aria-invalid={Boolean(errors.transactionHash)}
            className="figure h-10"
          />
        </Field>
      </div>
      <label className={confirmCard}>
        <input type="checkbox" name="confirmed" className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
        <span className="text-sm leading-relaxed text-ink-soft">
          <span className="font-medium text-foreground">
            I sent this transfer and authorize it as funding for this engagement.
          </span>{" "}
          It can be spent only under this engagement&apos;s mandate.
        </span>
      </label>
      <FieldError id="confirmed-error" messages={errors.confirmed} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Checking the chain…">{submitLabel}</SubmitButton>
        {errors.amount || errors.transactionHash || errors.confirmed ? null : <Status state={state} />}
      </div>
    </form>
  );
}

export function CancelEngagementForm({ engagementId }: { engagementId: string }) {
  const [state, action] = useActionState(cancelEngagementAction, initialFormState);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="destructive"
        size="lg"
        className="h-10 px-4"
        onClick={() => setConfirming(true)}
      >
        Cancel engagement
      </Button>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="engagementId" value={engagementId} />
      <p className="text-sm leading-relaxed text-ink-soft">
        Cancel this engagement? The agent&apos;s authority ends immediately and this can&apos;t be
        undone. Funds in the engagement&apos;s wallet stay there until you authorize their return.
      </p>
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="destructive" pendingLabel="Cancelling…">
          Yes, cancel it
        </SubmitButton>
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="h-10 px-4"
          onClick={() => setConfirming(false)}
        >
          Keep engagement
        </Button>
      </div>
      {!state.ok && state.message ? <FormMessage message={state.message} /> : null}
    </form>
  );
}
