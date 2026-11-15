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
  projects: Array<{
    id: string;
    name: string;
    hasWeb3: boolean;
    bundled: boolean;
    fit: { runnable: number; total: number; reason: string | null };
  }>;
}) {
  const [state, action] = useActionState(createEngagementAction, initialFormState);
  const errors = state.fieldErrors ?? {};
  const echoed = typeof state.values?.projectId === "string" ? state.values.projectId : null;
  // Offer first the projects this seller has something to do on.
  const ordered = [...projects].sort((a, b) => Number(b.fit.runnable > 0) - Number(a.fit.runnable > 0));
  const suited = ordered.filter((project) => project.fit.runnable > 0);
  const preselected = echoed ?? (suited.length === 1 ? suited[0].id : null);

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="sellerSlug" value={sellerSlug} />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-foreground">Which project is this for?</legend>
        <div className="grid gap-2">
          {ordered.map((project) => (
            <label key={project.id} className={choiceCard}>
              <span className="flex min-w-0 items-start gap-3">
                <input
                  type="radio"
                  name="projectId"
                  value={project.id}
                  defaultChecked={preselected === project.id}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{project.name}</span>
                  {project.fit.total === 0 ? null : project.fit.runnable === 0 ? (
                    <span className="mt-1 block text-xs leading-relaxed text-warn">
                      Nothing {sellerName} sells can be run on this project. {project.fit.reason}
                    </span>
                  ) : (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {project.fit.runnable === project.fit.total
                        ? `All ${project.fit.total} of ${sellerName}'s services can be run on it.`
                        : `${project.fit.runnable} of ${sellerName}'s ${project.fit.total} services can be run on it.`}
                    </span>
                  )}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs text-muted-foreground">
                {project.bundled ? "Bundled sample" : "Your own"}
                <span className="block">{project.hasWeb3 ? "Includes Web3" : "Conventional"}</span>
              </span>
            </label>
          ))}
        </div>
        {suited.length === 0 ? (
          <p className="text-sm leading-relaxed text-warn">
            None of your projects has anything {sellerName} can work on. Create a project that shares what it
            reads, then come back to this seller.
          </p>
        ) : null}
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
