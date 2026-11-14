"use client";

import { useActionState } from "react";
import { FieldError, FormMessage, SubmitButton } from "@/components/forms/field";
import { initialFormState } from "@/server/form-state";
import { createEngagementAction } from "../actions";

const choiceCard =
  "flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-border bg-background/40 p-4 transition-colors has-[:checked]:border-brand has-[:checked]:bg-brand-dim has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring hover:border-brand/40";

export function CreateEngagementForm({
  sellerSlug,
  sellerName,
  projects,
}: {
  sellerSlug: string;
  sellerName: string;
  projects: Array<{ id: string; name: string; hasWeb3: boolean }>;
}) {
  const [state, action] = useActionState(createEngagementAction, initialFormState);
  const errors = state.fieldErrors ?? {};
  const echoed = typeof state.values?.projectId === "string" ? state.values.projectId : null;
  const preselected = echoed ?? (projects.length === 1 ? projects[0].id : null);

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="sellerSlug" value={sellerSlug} />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-foreground">Which project is this for?</legend>
        <div className="grid gap-2">
          {projects.map((project) => (
            <label key={project.id} className={choiceCard}>
              <span className="flex items-center gap-3">
                <input
                  type="radio"
                  name="projectId"
                  value={project.id}
                  defaultChecked={preselected === project.id}
                  className="size-4 accent-[var(--brand)]"
                />
                <span className="text-sm font-medium text-foreground">{project.name}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {project.hasWeb3 ? "Includes Web3" : "Conventional"}
              </span>
            </label>
          ))}
        </div>
        <FieldError id="projectId-error" messages={errors.projectId} />
      </fieldset>

      <p className="text-sm leading-relaxed text-muted-foreground">
        Creating the engagement records that you chose {sellerName} for this project. It authorizes
        nothing: you&apos;ll set the budget and give your go-ahead on the next screen.
      </p>

      {state.message && !errors.projectId ? <FormMessage message={state.message} /> : null}
      <SubmitButton pendingLabel="Creating…">Create engagement</SubmitButton>
    </form>
  );
}
