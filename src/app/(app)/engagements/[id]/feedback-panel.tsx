import { Panel } from "@/components/app/page-header";
import { ChainLink } from "@/components/goat/chain-link";
import { CaseStatusBadge, Stars } from "@/components/reputation/stars";
import type { ValidationCase } from "@/db/schema";
import type { EngagementFeedback } from "@/server/reputation";
import { CheckRatingForm, RateForm, ReportProblemForm } from "./feedback-forms";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

function CaseRecord({ record }: { record: ValidationCase }) {
  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm font-medium text-foreground">
          {record.origin === "low_rating" ? "Opened by your rating" : "Problem you reported"}
          <span className="font-normal text-muted-foreground"> · {dateFormat.format(record.createdAt)}</span>
        </p>
        <CaseStatusBadge status={record.status} />
      </div>
      <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{record.reason}</p>
      {record.sellerResponse ? (
        <div>
          <p className="eyebrow">The seller&apos;s reply</p>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{record.sellerResponse}</p>
        </div>
      ) : null}
      {record.status !== "open" ? (
        <div className="rounded-lg border border-border bg-background/40 p-3">
          <p className="eyebrow">905 Finance&apos;s verdict</p>
          <p className="mt-1 text-sm text-foreground">
            Score for the seller&apos;s work: <span className="figure">{record.score} / 100</span>
          </p>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{record.verdictNote}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          905 Finance reviews this with the test records and the seller&apos;s reply. Nothing more is needed from you.
        </p>
      )}
    </li>
  );
}

/** The buyer's rating of the seller, and any problem put to 905 Finance, for one engagement. */
export function FeedbackPanel({
  engagementId,
  sellerName,
  feedback,
}: {
  engagementId: string;
  sellerName: string;
  feedback: EngagementFeedback;
}) {
  const { rating, cases } = feedback;
  // Nothing to show until something has been bought.
  if (!rating && cases.length === 0 && feedback.rateBlockedBy) return null;
  return (
    <Panel
      title="Rating and review"
      description={`Your rating of ${sellerName} counts towards its reputation. Problems go to 905 Finance to validate.`}
    >
      <div className="space-y-6">
        {rating ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Stars stars={rating.stars} />
              <span className="text-sm text-foreground">{rating.stars} of 5</span>
              <span className="text-xs text-muted-foreground">Rated {dateFormat.format(rating.createdAt)}</span>
            </div>
            {rating.comment ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{rating.comment}</p>
            ) : null}
            {rating.chainStatus === "confirmed" && rating.chainRef ? (
              <p className="text-xs text-muted-foreground">
                Written to GOAT&apos;s ERC-8004 Reputation Registry: <ChainLink value={rating.chainRef} short />
              </p>
            ) : rating.chainStatus === "sent" ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Sent to GOAT&apos;s Reputation Registry and waiting for the chain to confirm it.
                  {rating.chainRef ? (
                    <>
                      {" "}
                      <ChainLink value={rating.chainRef} short />
                    </>
                  ) : null}
                </p>
                {feedback.canAct ? <CheckRatingForm engagementId={engagementId} /> : null}
              </div>
            ) : rating.chainStatus === "failed" || rating.chainStatus === "uncertain" ? (
              <p className="text-xs text-warn">
                Recorded on 905 Finance. It is not in GOAT&apos;s Reputation Registry: {rating.chainProblem}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Recorded on 905 Finance. A rating is also written to GOAT&apos;s Reputation Registry when the
                engagement is settled on GOAT and the seller has a confirmed ERC-8004 identity.
              </p>
            )}
          </div>
        ) : feedback.canAct ? (
          <RateForm engagementId={engagementId} sellerName={sellerName} />
        ) : (
          <p className="text-sm text-muted-foreground">Owners and admins can rate the seller.</p>
        )}

        {cases.length > 0 ? (
          <div className="border-t border-border pt-2">
            <ul className="divide-y divide-border">
              {cases.map((record) => (
                <CaseRecord key={record.id} record={record} />
              ))}
            </ul>
          </div>
        ) : null}

        {feedback.canAct && !feedback.reportBlockedBy ? (
          <div className="border-t border-border pt-5">
            <ReportProblemForm engagementId={engagementId} />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
