import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import type { ProofTagData } from "@/server/proofs";

/**
 * Where a record's proof stands. It is a link to the proof once the record
 * has a fingerprint; a record without one shows nothing.
 */
export function ProofTag({ proof }: { proof: ProofTagData | undefined }) {
  if (!proof) return null;
  const label =
    proof.state === "confirmed"
      ? "Proof on GOAT"
      : proof.state === "sent"
        ? "Proof being confirmed"
        : "Proof waiting to be written";
  return (
    <Link
      href={`/proofs/${proof.recordId}`}
      className={
        proof.state === "confirmed"
          ? "inline-flex items-center gap-1 text-xs text-brand underline decoration-brand/40 underline-offset-4 hover:decoration-brand"
          : "inline-flex items-center gap-1 text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
      }
    >
      <ShieldCheck className="size-3.5" aria-hidden="true" />
      {label}
    </Link>
  );
}
