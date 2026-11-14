"use client";

import { useActionState, useState } from "react";
import { FormMessage, SubmitButton } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { initialFormState } from "@/server/form-state";
import { deleteProjectAction } from "../actions";

export function DeleteProjectForm({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [state, action] = useActionState(deleteProjectAction, initialFormState);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button type="button" variant="destructive" size="lg" className="h-10 px-4" onClick={() => setConfirming(true)}>
        Delete project
      </Button>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="projectId" value={projectId} />
      <p className="text-sm text-ink-soft">
        Delete <span className="font-medium text-foreground">{projectName}</span>? This can't be undone.
      </p>
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="destructive" pendingLabel="Deleting…">
          Yes, delete it
        </SubmitButton>
        <Button type="button" variant="ghost" size="lg" className="h-10 px-4" onClick={() => setConfirming(false)}>
          Keep project
        </Button>
      </div>
      {state.message ? <FormMessage message={state.message} /> : null}
    </form>
  );
}
