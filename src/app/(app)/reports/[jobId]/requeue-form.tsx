"use client";

import { useActionState } from "react";
import { FormMessage, SubmitButton } from "@/components/forms/field";
import { initialFormState } from "@/server/form-state";
import { requeueJobAction } from "../actions";

/** For a test that was paid for and could not run: try it again at no charge. */
export function RequeueJobForm({ jobId }: { jobId: string }) {
  const [state, action] = useActionState(requeueJobAction, initialFormState);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="jobId" value={jobId} />
      <SubmitButton pendingLabel="Queueing…">Run this test again</SubmitButton>
      {state.message ? <FormMessage message={state.message} tone={state.ok ? "success" : "error"} /> : null}
    </form>
  );
}
