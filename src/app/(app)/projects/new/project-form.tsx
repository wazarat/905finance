"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import Link from "next/link";
import { Field, FieldError, FormMessage, controlClass } from "@/components/forms/field";
import { CapabilityChip } from "@/components/sellers/badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PROJECT_FIXTURES, capabilitiesForProject } from "@/lib/capabilities";
import { FILE_LIMITS, MAX_ADDRESSES, isRepositoryCapability } from "@/lib/repository";
import { cn } from "@/lib/utils";
import { initialFormState } from "@/server/form-state";
import { createProjectAction } from "../actions";

const choiceCard =
  "flex cursor-pointer flex-col rounded-xl border border-border bg-card p-4 transition-colors has-[:checked]:border-brand has-[:checked]:bg-brand-dim has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring hover:border-brand/40";

function str(values: Record<string, string | string[]> | undefined, key: string, fallback = "") {
  const v = values?.[key];
  return typeof v === "string" ? v : fallback;
}

export function ProjectForm() {
  const [state, action, pending] = useActionState(createProjectAction, initialFormState);
  const errors = state.fieldErrors ?? {};
  const [sourceType, setSourceType] = useState(str(state.values, "sourceType", "repository"));
  const [web3, setWeb3] = useState(str(state.values, "hasWeb3"));
  const own = sourceType === "repository";
  // What is shared from a project of your own is read, never run, so only the first looks apply to it.
  const capabilities = (web3 ? capabilitiesForProject(web3 === "yes") : []).filter(
    (capability) => !own || isRepositoryCapability(capability.key),
  );

  // Sent by hand so that a correction leaves the form as it was filled in, chosen files included.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => action(data));
  };

  return (
    <form action={action} onSubmit={submit} className="space-y-10" noValidate>
      <section className="space-y-6">
        <h2 className="eyebrow">Project</h2>
        <Field id="name" label="Project name" errors={errors.name}>
          <Input
            id="name"
            name="name"
            required
            defaultValue={str(state.values, "name")}
            aria-invalid={Boolean(errors.name)}
            className="h-10 sm:max-w-md"
          />
        </Field>
        <Field id="description" label="Description" optional errors={errors.description}>
          <textarea
            id="description"
            name="description"
            rows={3}
            defaultValue={str(state.values, "description")}
            className={cn(controlClass, "py-2.5")}
          />
        </Field>
      </section>

      <section className="space-y-6">
        <h2 className="eyebrow">What should be tested</h2>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-foreground">Source</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={choiceCard}>
              <input
                type="radio"
                name="sourceType"
                value="repository"
                checked={sourceType === "repository"}
                onChange={() => setSourceType("repository")}
                className="sr-only"
              />
              <span className="font-medium text-foreground">My own project</span>
              <span className="mt-1 text-sm text-muted-foreground">
                Share any of a repository, a website, source files or contract addresses. What you share is
                read, never run.
              </span>
            </label>
            <label className={choiceCard}>
              <input
                type="radio"
                name="sourceType"
                value="fixture"
                checked={sourceType === "fixture"}
                onChange={() => setSourceType("fixture")}
                className="sr-only"
              />
              <span className="font-medium text-foreground">Bundled test fixture</span>
              <span className="mt-1 text-sm text-muted-foreground">
                A project with known defects. Every kind of test can run on it.
              </span>
            </label>
          </div>
          <FieldError id="sourceType-error" messages={errors.sourceType} />
        </fieldset>

        {sourceType === "repository" ? (
          <>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Share at least one of the following. Each one opens up a different first-look report.
            </p>
            <Field
              id="repositoryUrl"
              label="GitHub repository"
              optional
              hint="A public repository, for example https://github.com/your-org/your-repo. Its JavaScript, TypeScript and Solidity are read; nothing in it is installed, built or run."
              errors={errors.repositoryUrl}
            >
              <Input
                id="repositoryUrl"
                name="repositoryUrl"
                type="url"
                inputMode="url"
                placeholder="https://github.com/your-org/your-repo"
                defaultValue={str(state.values, "repositoryUrl")}
                aria-invalid={Boolean(errors.repositoryUrl)}
                className="h-10"
              />
            </Field>
            <Field
              id="applicationUrl"
              label="Website"
              optional
              hint="Your site's address. A website check opens it the way a visitor's browser would and reports its security settings. It submits nothing and does not probe."
              errors={errors.applicationUrl}
            >
              <Input
                id="applicationUrl"
                name="applicationUrl"
                type="url"
                inputMode="url"
                placeholder="https://www.example.com"
                defaultValue={str(state.values, "applicationUrl")}
                aria-invalid={Boolean(errors.applicationUrl)}
                className="h-10"
              />
            </Field>
            <Field
              id="files"
              label="Source files"
              optional
              hint={`Share certain files instead of a whole repository: JavaScript, TypeScript or Solidity, up to ${FILE_LIMITS.files} files of ${FILE_LIMITS.bytesEach / 1024} KB each, ${FILE_LIMITS.bytesTotal / 1024} KB in all. They are read by the scans you buy and are never run.`}
              errors={errors.files}
            >
              <input
                id="files"
                name="files"
                type="file"
                multiple
                accept=".js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts,.sol"
                aria-invalid={Boolean(errors.files)}
                className={cn(controlClass, "h-auto py-2 file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm file:text-foreground")}
              />
            </Field>
          </>
        ) : (
          <Field
            id="fixtureKey"
            label="Fixture"
            hint="A bundled project with known defects. Every kind of test can run on it."
            errors={errors.fixtureKey}
          >
            <select
              id="fixtureKey"
              name="fixtureKey"
              // Keyed so the echoed value is re-applied when the form resets after submit.
              key={str(state.values, "fixtureKey")}
              defaultValue={str(state.values, "fixtureKey")}
              aria-invalid={Boolean(errors.fixtureKey)}
              className={cn(controlClass, "h-10 sm:max-w-md")}
            >
              <option value="">Choose a fixture…</option>
              {PROJECT_FIXTURES.map((fixture) => (
                <option key={fixture.key} value={fixture.key}>
                  {fixture.label} — {fixture.description}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field
          id="testingObjectives"
          label="Testing objectives"
          optional
          hint="What you most want to learn, e.g. “catch regressions in checkout before release”."
          errors={errors.testingObjectives}
        >
          <textarea
            id="testingObjectives"
            name="testingObjectives"
            rows={3}
            defaultValue={str(state.values, "testingObjectives")}
            className={cn(controlClass, "py-2.5")}
          />
        </Field>
      </section>

      <section className="space-y-4">
        <h2 className="eyebrow">Web3</h2>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-foreground">
            Does your project include smart contracts or Web3 components?
          </legend>
          <div className="flex flex-wrap gap-3">
            {(["yes", "no"] as const).map((option) => (
              <label key={option} className={cn(choiceCard, "min-w-28 flex-row items-center px-5 py-2.5")}>
                <input
                  type="radio"
                  name="hasWeb3"
                  value={option}
                  checked={web3 === option}
                  onChange={() => setWeb3(option)}
                  className="sr-only"
                />
                <span className="text-sm font-medium text-foreground capitalize">{option}</span>
              </label>
            ))}
          </div>
          {/* A fixture mismatch still applies after answering; "unanswered" does not. */}
          <FieldError id="hasWeb3-error" messages={web3 === str(state.values, "hasWeb3") ? errors.hasWeb3 : undefined} />
        </fieldset>

        {web3 === "yes" && sourceType === "repository" ? (
          <Field
            id="contractAddresses"
            label="Contract addresses"
            optional
            hint={`Public addresses of your contracts on GOAT Testnet3, one per line, up to ${MAX_ADDRESSES}. A contract check reads what the chain and its explorer say about each one. Never share a private key: nothing here needs one.`}
            errors={errors.contractAddresses}
          >
            <textarea
              id="contractAddresses"
              name="contractAddresses"
              rows={3}
              placeholder="0x…"
              defaultValue={str(state.values, "contractAddresses")}
              aria-invalid={Boolean(errors.contractAddresses)}
              className={cn(controlClass, "figure h-auto py-2.5")}
            />
          </Field>
        ) : null}

        <div className="rounded-xl border border-border bg-card p-5" aria-live="polite">
          <p className="text-sm font-medium text-foreground">Testing available for this project</p>
          {capabilities.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Answer the question above to see which kinds of testing apply.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                {own
                  ? "First looks, which read what you share. Tests that run a project's code are for the bundled fixtures."
                  : web3 === "yes"
                    ? "Conventional software testing, plus smart-contract testing."
                    : "Conventional software testing."}
              </p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {capabilities.map((capability) => (
                  <CapabilityChip key={capability.key} capability={capability.key} />
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow">Authorization</h2>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-5 has-[:checked]:border-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
          <input
            type="checkbox"
            name="testingAuthorized"
            defaultChecked={str(state.values, "testingAuthorized") === "on"}
            aria-describedby={errors.testingAuthorized ? "testingAuthorized-error" : undefined}
            className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
          />
          <span className="text-sm leading-relaxed text-ink-soft">
            <span className="font-medium text-foreground">
              I am authorized to have this project tested.
            </span>{" "}
            I own the code, website and contracts shared above, or have the owner's permission
            for testing, including security testing. Tests are never run against third-party systems
            without approval.
          </span>
        </label>
        <FieldError id="testingAuthorized-error" messages={errors.testingAuthorized} />
      </section>

      {state.message ? <FormMessage message={state.message} /> : null}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="lg" disabled={pending} aria-disabled={pending} className="h-11 px-5 text-[0.95rem]">
          {pending ? "Creating project…" : "Create project"}
        </Button>
        <Button asChild variant="ghost" size="lg" className="h-11 px-4">
          <Link href="/projects">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
