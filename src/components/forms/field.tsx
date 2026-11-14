"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function FieldError({ id, messages }: { id: string; messages?: string[] }) {
  if (!messages || messages.length === 0) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {messages.join(" ")}
    </p>
  );
}

/** Label, optional hint, control and error message wired together for accessibility. */
export function Field({
  id,
  label,
  hint,
  optional,
  errors,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  optional?: boolean;
  errors?: string[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </Label>
        {optional ? <span className="text-xs text-muted-foreground">Optional</span> : null}
      </div>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} messages={errors} />
    </div>
  );
}

export function FormMessage({ message, tone = "error" }: { message?: string; tone?: "error" | "success" }) {
  if (!message) return null;
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border px-3 py-2.5 text-sm",
        tone === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-brand/30 bg-brand-dim text-brand",
      )}
    >
      {message}
    </p>
  );
}

export function SubmitButton({
  children,
  pendingLabel,
  className,
  variant,
  disabled,
}: {
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="lg"
      variant={variant}
      disabled={pending || disabled}
      aria-disabled={pending || disabled}
      className={cn("h-10 px-4", className)}
    >
      {pending ? (pendingLabel ?? "Saving…") : children}
    </Button>
  );
}

/** Shared styling for native selects and textareas so they match the inputs. */
export const controlClass =
  "w-full rounded-lg border border-input bg-input/30 px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";
