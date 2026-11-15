import type { ReactNode } from "react";
import { CaseStatusBadge, Stars, averageLabel } from "@/components/reputation/stars";
import type { SellerFeedback, SellerReputation } from "@/server/reputation";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** Counts and an average: what anyone may see of a seller's standing on 905 Finance. */
export function ReputationSummary({ reputation }: { reputation: SellerReputation }) {
  if (reputation.ratings === 0) {
    return <p className="text-sm text-muted-foreground">No buyer has rated this seller yet.</p>;
  }
  const most = Math.max(...reputation.distribution, 1);
  const decided = reputation.cases.upheld + reputation.cases.notUpheld;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="figure text-3xl text-foreground">{averageLabel(reputation.averageTenths ?? 0)}</span>
        <Stars stars={(reputation.averageTenths ?? 0) / 10} />
        <span className="text-sm text-muted-foreground">
          from {reputation.ratings} {reputation.ratings === 1 ? "engagement" : "engagements"}
        </span>
      </div>
      <dl className="space-y-1.5">
        {[5, 4, 3, 2, 1].map((stars) => {
          const count = reputation.distribution[stars - 1];
          return (
            <div key={stars} className="flex items-center gap-3 text-xs text-muted-foreground">
              <dt className="w-12 shrink-0">
                {stars} {stars === 1 ? "star" : "stars"}
              </dt>
              <dd className="flex min-w-0 flex-1 items-center gap-2">
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full rounded-full bg-warn" style={{ width: `${(count / most) * 100}%` }} />
                </span>
                <span className="figure w-6 text-right tabular-nums">{count}</span>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {reputation.onChain > 0
          ? `${reputation.onChain} of these ${reputation.onChain === 1 ? "is" : "are"} also written to GOAT's ERC-8004 Reputation Registry. `
          : ""}
        {decided + reputation.cases.open === 0
          ? "No problem has been put to 905 Finance about this seller."
          : `905 Finance has reviewed ${decided} ${decided === 1 ? "complaint" : "complaints"}: ${reputation.cases.upheld} upheld, ${reputation.cases.notUpheld} not upheld${reputation.cases.open > 0 ? `, and ${reputation.cases.open} under review` : ""}.`}
      </p>
    </div>
  );
}

/** A seller's own view: every rating with its comment, and every case with its verdict. */
export function SellerFeedbackList({
  feedback,
  respond,
}: {
  feedback: SellerFeedback;
  respond: (caseId: string) => ReactNode;
}) {
  return (
    <div className="space-y-6">
      <ReputationSummary reputation={feedback.reputation} />
      {feedback.cases.length > 0 ? (
        <div className="border-t border-border pt-4">
          <p className="eyebrow">Problems put to 905 Finance</p>
          <ul className="mt-1 divide-y divide-border">
            {feedback.cases.map((record) => (
              <li key={record.id} className="space-y-3 py-4">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="text-sm text-muted-foreground">
                    {record.origin === "low_rating" ? "Opened by a low rating" : "Reported by the buyer"} ·{" "}
                    {dateFormat.format(record.createdAt)}
                  </p>
                  <CaseStatusBadge status={record.status} />
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{record.reason}</p>
                {record.sellerResponse ? (
                  <div>
                    <p className="eyebrow">Your reply</p>
                    <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">
                      {record.sellerResponse}
                    </p>
                  </div>
                ) : record.status === "open" && feedback.canRespond ? (
                  respond(record.id)
                ) : null}
                {record.status !== "open" ? (
                  <div className="rounded-lg border border-border bg-background/40 p-3">
                    <p className="eyebrow">905 Finance&apos;s verdict</p>
                    <p className="mt-1 text-sm text-foreground">
                      Score for your work: <span className="figure">{record.score} / 100</span>
                    </p>
                    <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">
                      {record.verdictNote}
                    </p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {feedback.ratings.length > 0 ? (
        <div className="border-t border-border pt-4">
          <p className="eyebrow">Ratings</p>
          <ul className="mt-1 divide-y divide-border">
            {feedback.ratings.map((rating) => (
              <li key={rating.id} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Stars stars={rating.stars} />
                  <span className="text-xs text-muted-foreground">{dateFormat.format(rating.createdAt)}</span>
                  {rating.chainStatus === "confirmed" ? (
                    <span className="text-xs text-brand">In GOAT&apos;s Reputation Registry</span>
                  ) : null}
                </div>
                {rating.comment ? (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{rating.comment}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
