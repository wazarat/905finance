import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { CapabilityChip } from "@/components/sellers/badges";
import { formatMoney } from "@/lib/money";
import type { PublicSeller } from "@/server/marketplace";

const MAX_CHIPS = 4;

export function SellerCard({ seller }: { seller: PublicSeller }) {
  const extra = seller.capabilities.length - MAX_CHIPS;
  return (
    <Link
      href={`/agents/${seller.slug}`}
      className="group flex h-full flex-col rounded-xl border border-border bg-card p-6 transition-colors outline-none hover:border-brand/40 focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold text-foreground">{seller.displayName}</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{seller.tagline}</p>
        </div>
        <ArrowUpRight
          className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-brand"
          aria-hidden="true"
        />
      </div>

      <div className="mt-5 flex flex-wrap gap-1.5">
        {seller.capabilities.slice(0, MAX_CHIPS).map((capability) => (
          <CapabilityChip key={capability} capability={capability} />
        ))}
        {extra > 0 ? (
          <span className="inline-flex items-center rounded-md px-1.5 py-1 text-xs text-muted-foreground">
            +{extra} more
          </span>
        ) : null}
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 pt-6">
        <div>
          <p className="eyebrow">Services from</p>
          <p className="figure mt-1 text-base text-foreground">
            {seller.startingPriceMinor !== null
              ? formatMoney(seller.startingPriceMinor, seller.startingPriceCurrency ?? "USD")
              : "—"}
          </p>
        </div>
        {seller.periods.length > 0 ? (
          <p className="text-right text-xs leading-relaxed text-muted-foreground">
            Works over a period
            <span className="block text-foreground">{seller.periods.join(", ")} days</span>
          </p>
        ) : null}
      </div>
    </Link>
  );
}
