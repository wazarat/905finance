import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, Clock, Download, X } from "lucide-react";
import { PageHeader, Panel } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { ChainLink } from "@/components/goat/chain-link";
import { Button } from "@/components/ui/button";
import { GOAT_TESTNET3 } from "@/lib/goat";
import { isAppError } from "@/server/errors";
import { requireWorkspace } from "@/server/page-context";
import { PROOF_PREFIX, getProof, type ProofDetail } from "@/server/proofs";
import { RunProofsForm } from "../run-proofs-form";

export const metadata: Metadata = { title: "Proof" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" });

const KINDS: Record<string, string> = {
  payment: "Payment",
  funding: "Funding",
  return: "Return of unused funds",
  rating: "Rating",
  verdict: "Verdict",
};

function pretty(document: string): string {
  try {
    return JSON.stringify(JSON.parse(document), null, 2);
  } catch {
    return document;
  }
}

async function ProofContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor } = await requireWorkspace();
  let proof: ProofDetail;
  try {
    proof = await getProof(actor, id);
  } catch (error) {
    if (isAppError(error)) notFound();
    throw error;
  }
  const { record, batch } = proof;
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`${KINDS[record.kind] ?? record.kind} · proof`}
        title={
          proof.state === "confirmed"
            ? "On GOAT Testnet3"
            : proof.state === "sent"
              ? "Being confirmed on GOAT Testnet3"
              : "Waiting to be written to GOAT"
        }
        description="A fingerprint of this record, written to the chain so that anyone holding the record can check it was not changed afterwards."
        actions={
          batch ? (
            <Button asChild variant="outline" size="lg" className="h-10 px-4">
              <a href={`/proofs/${record.id}/proof.json`}>
                <Download className="size-4" aria-hidden="true" /> Download proof
              </a>
            </Button>
          ) : null
        }
      />

      {batch ? (
        <Panel
          title={
            proof.verified
              ? "Checked just now: it holds"
              : proof.state === "sent" && proof.checks.slice(0, 3).every((check) => check.passed)
                ? "Sent, and waiting for the chain to settle it"
                : "Checked just now: not proven"
          }
          description="Every step below was done again as this page loaded, against the chain itself."
        >
          <ul className="space-y-2.5">
            {proof.checks.map((check) => (
              <li key={check.label} className="flex items-start gap-2.5 text-sm">
                {check.passed ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
                ) : proof.state === "sent" ? (
                  <Clock className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
                ) : (
                  <X className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                )}
                <span className={check.passed ? "text-ink-soft" : proof.state === "sent" ? "text-warn" : "text-destructive"}>
                  {check.label}
                  <span className="sr-only">
                    {check.passed ? " (passed)" : proof.state === "sent" ? " (not yet)" : " (failed)"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {proof.state === "sent" ? (
            <p className="mt-4 text-sm text-muted-foreground">
              The transaction has been sent and is waiting for blocks on top of it. Reload in a moment.
            </p>
          ) : null}
        </Panel>
      ) : (
        <Panel title="Not on the chain yet" description="The record has its fingerprint. It has not been written to GOAT.">
          <RunProofsForm />
        </Panel>
      )}

      <Panel
        title="What this proves"
        description="That the record below existed, exactly as shown, when the transaction was made."
      >
        <p className="max-w-2xl text-sm leading-relaxed text-ink-soft">
          It is a proof of the record, not of a movement of money. The record itself says how it was settled:
          a payment in test funds stays a payment in test funds.
        </p>
      </Panel>

      <Panel title="The record" description="This exact text is what the fingerprint was taken of.">
        <pre className="figure max-h-96 overflow-auto rounded-lg border border-border bg-background/60 p-4 text-xs leading-relaxed whitespace-pre-wrap text-ink-soft">
          {pretty(record.document)}
        </pre>
        <dl className="mt-5 space-y-4 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Fingerprint (keccak256 of the text as stored)</dt>
            <dd className="figure mt-1 text-xs break-all text-foreground">{record.recordHash}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Recorded</dt>
            <dd className="mt-1">{dateTimeFormat.format(record.createdAt)}</dd>
          </div>
        </dl>
      </Panel>

      {batch ? (
        <Panel title="On the chain" description={`${GOAT_TESTNET3.name}, chain ${GOAT_TESTNET3.id}.`}>
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Transaction</dt>
              <dd className="mt-1 text-xs">
                <ChainLink value={batch.txHash} />
              </dd>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Block</dt>
                <dd className="figure mt-1">{batch.blockNumber ?? "Not settled yet"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Sent by 905 Finance&apos;s proof wallet</dt>
                <dd className="mt-1 text-xs">
                  <ChainLink value={batch.walletAddress} short />
                </dd>
              </div>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                The transaction&apos;s data: <span className="figure">{PROOF_PREFIX}</span> then the combined fingerprint
              </dt>
              <dd className="figure mt-1 text-xs break-all text-foreground">{batch.data}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                Combined fingerprint of the {batch.hashes.length} {batch.hashes.length === 1 ? "record" : "records"} written
                together (keccak256 of their fingerprints, joined in order)
              </dt>
              <dd className="figure mt-1 text-xs break-all text-foreground">{batch.root}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Fingerprints in this batch, in order</dt>
              <dd className="mt-1">
                <ol className="figure max-h-48 space-y-0.5 overflow-auto rounded-lg border border-border bg-background/60 p-3 text-xs">
                  {batch.hashes.map((hash, index) => (
                    <li key={hash} className={index === batch.position ? "break-all text-brand" : "break-all text-muted-foreground"}>
                      {hash}
                      {index === batch.position ? " (this record)" : ""}
                    </li>
                  ))}
                </ol>
              </dd>
            </div>
          </dl>
        </Panel>
      ) : null}

      <p className="text-sm">
        <Link href="/transactions" className="text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Back to transactions
        </Link>
      </p>
    </div>
  );
}

export default function ProofPage({ params }: PageProps<"/proofs/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ProofContent params={params} />
    </Suspense>
  );
}
