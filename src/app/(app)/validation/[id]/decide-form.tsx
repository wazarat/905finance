"use client";

import { useActionState } from "react";
import { Field, FieldError, FormMessage, SubmitButton, controlClass } from "@/components/forms/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { initialFormState } from "@/server/form-state";
import { decideCaseAction } from "../actions";

const choice =
  "flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background/40 p-3 transition-colors has-[:checked]:border-brand/60 has-[:checked]:bg-brand-dim has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring";

/** The validator's verdict: whether the complaint stands, a score for the work, and the reason. */
export function DecideForm({ caseId }: { caseId: string }) {
  const [state, action] = useActionState(decideCaseAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  const value = (name: string) => (!state.ok && typeof state.values?.[name] === "string" ? (state.values[name] as string) : "");
  return (
    <form action={action} className="space-y-5" noValidate>
      <input type="hidden" name="caseId" value={caseId} />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">Verdict</legend>
        <label className={choice}>
          <input type="radio" name="verdict" value="upheld" defaultChecked={value("verdict") === "upheld"} className="mt-1 accent-[var(--brand)]" />
          <span className="text-sm leading-relaxed text-ink-soft">
            <span className="font-medium text-foreground">The complaint is upheld.</span> The seller&apos;s work fell
            short of what was bought.
          </span>
        </label>
        <label className={choice}>
          <input type="radio" name="verdict" value="not_upheld" defaultChecked={value("verdict") === "not_upheld"} className="mt-1 accent-[var(--brand)]" />
          <span className="text-sm leading-relaxed text-ink-soft">
            <span className="font-medium text-foreground">The complaint is not upheld.</span> The seller delivered
            what was bought.
          </span>
        </label>
        <FieldError id="verdict-error" messages={errors.verdict} />
      </fieldset>
      <Field
        id="score"
        label="Score for the seller's work (0 to 100)"
        hint="Below 50 when the complaint is upheld; 50 or above when it is not."
        errors={errors.score}
      >
        <Input id="score" name="score" inputMode="numeric" defaultValue={value("score")} aria-invalid={Boolean(errors.score)} className="figure h-10 max-w-28" />
      </Field>
      <div className="space-y-2">
        <label htmlFor="note" className="text-sm font-medium text-foreground">
          Reason
        </label>
        <textarea
          id="note"
          name="note"
          rows={4}
          maxLength={2000}
          defaultValue={value("note")}
          aria-invalid={Boolean(errors.note)}
          className={cn(controlClass, "h-auto py-2")}
        />
        <p className="text-xs text-muted-foreground">Both sides read this.</p>
        <FieldError id="note-error" messages={errors.note} />
      </div>
      <label className={choice}>
        <input type="checkbox" name="confirmed" className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
        <span className="text-sm leading-relaxed text-ink-soft">
          <span className="font-medium text-foreground">This is 905 Finance&apos;s verdict.</span> It is final and
          cannot be changed.
        </span>
      </label>
      <FieldError id="confirmed-error" messages={errors.confirmed} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Recording…">Record verdict</SubmitButton>
        {state.message && Object.keys(errors).length === 0 ? (
          <FormMessage message={state.message} tone={state.ok ? "success" : "error"} />
        ) : null}
      </div>
    </form>
  );
}
