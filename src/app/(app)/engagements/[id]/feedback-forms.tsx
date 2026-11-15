"use client";

import { useActionState, useState } from "react";
import { Star } from "lucide-react";
import { FieldError, FormMessage, SubmitButton, controlClass } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { initialFormState } from "@/server/form-state";
import { checkRatingAction, rateEngagementAction, reportProblemAction } from "../actions";

const WORDS = ["", "Poor", "Below expectations", "Acceptable", "Good", "Excellent"];

/** One to five stars and a comment. A rating is given once. */
export function RateForm({ engagementId, sellerName }: { engagementId: string; sellerName: string }) {
  const [state, action] = useActionState(rateEngagementAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  const echoed = !state.ok && typeof state.values?.stars === "string" ? Number(state.values.stars) : 0;
  const [stars, setStars] = useState(echoed);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="engagementId" value={engagementId} />
      <fieldset>
        <legend className="text-sm font-medium text-foreground">How was {sellerName}&apos;s work?</legend>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((value) => (
              <label
                key={value}
                className="cursor-pointer rounded-md p-1 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              >
                <input
                  type="radio"
                  name="stars"
                  value={value}
                  checked={stars === value}
                  onChange={() => setStars(value)}
                  className="sr-only"
                />
                <Star
                  aria-hidden="true"
                  className={cn("size-7", value <= stars ? "fill-warn text-warn" : "text-muted-foreground/60")}
                />
                <span className="sr-only">
                  {value} {value === 1 ? "star" : "stars"}
                </span>
              </label>
            ))}
          </div>
          <span className="text-sm text-muted-foreground">{stars ? `${stars} of 5 · ${WORDS[stars]}` : "Choose a rating"}</span>
        </div>
        <FieldError id="stars-error" messages={errors.stars} />
      </fieldset>
      <div className="space-y-2">
        <label htmlFor="rating-comment" className="text-sm font-medium text-foreground">
          Comment
        </label>
        <textarea
          id="rating-comment"
          name="comment"
          rows={3}
          maxLength={1000}
          defaultValue={!state.ok && typeof state.values?.comment === "string" ? state.values.comment : ""}
          placeholder={stars > 0 && stars <= 2 ? "What went wrong?" : "Optional"}
          aria-invalid={Boolean(errors.comment)}
          className={cn(controlClass, "h-auto py-2")}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Seen by the seller and by 905 Finance, not by the public. One or two stars also sends the engagement to
          905 Finance for review, and needs a comment.
        </p>
        <FieldError id="rating-comment-error" messages={errors.comment} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…">Submit rating</SubmitButton>
        <span className="text-xs text-muted-foreground">A rating is given once and cannot be edited.</span>
      </div>
      {state.message && !errors.comment && !errors.stars ? (
        <FormMessage message={state.message} tone={state.ok ? "success" : "error"} />
      ) : null}
    </form>
  );
}

/** Puts a problem to 905 Finance. Opens behind a button so it is not pressed by accident. */
export function ReportProblemForm({ engagementId }: { engagementId: string }) {
  const [state, action] = useActionState(reportProblemAction, initialFormState);
  const errors = state.ok ? {} : (state.fieldErrors ?? {});
  const [open, setOpen] = useState(false);
  if (state.ok && state.message) return <FormMessage message={state.message} tone="success" />;
  if (!open) {
    return (
      <Button type="button" variant="outline" size="lg" className="h-10 px-4" onClick={() => setOpen(true)}>
        Report a problem
      </Button>
    );
  }
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="engagementId" value={engagementId} />
      <label htmlFor="problem-reason" className="text-sm font-medium text-foreground">
        What is the problem?
      </label>
      <textarea
        id="problem-reason"
        name="reason"
        rows={4}
        maxLength={2000}
        defaultValue={!state.ok && typeof state.values?.reason === "string" ? state.values.reason : ""}
        aria-invalid={Boolean(errors.reason)}
        className={cn(controlClass, "h-auto py-2")}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        905 Finance reviews it with the test records and the seller&apos;s reply, and gives a verdict. It does not
        reverse a payment.
      </p>
      <FieldError id="problem-reason-error" messages={errors.reason} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Sending…">Send to 905 Finance</SubmitButton>
        <Button type="button" variant="ghost" size="lg" className="h-10 px-4" onClick={() => setOpen(false)}>
          Not now
        </Button>
      </div>
      {state.message && !errors.reason ? <FormMessage message={state.message} tone="error" /> : null}
    </form>
  );
}

export function CheckRatingForm({ engagementId }: { engagementId: string }) {
  const [state, action] = useActionState(checkRatingAction, initialFormState);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="engagementId" value={engagementId} />
      <SubmitButton variant="outline" pendingLabel="Checking the chain…">
        Check again
      </SubmitButton>
      {state.message ? <FormMessage message={state.message} tone={state.ok ? "success" : "error"} /> : null}
    </form>
  );
}
