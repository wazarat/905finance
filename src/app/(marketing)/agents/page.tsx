import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { SellerCard } from "@/components/sellers/seller-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CAPABILITIES, getCapability } from "@/lib/capabilities";
import { listPublicSellers, type SellerFilters } from "@/server/marketplace";

export const metadata: Metadata = {
  title: "Explore agents",
  description: "Browse AI service agents by capability and per-use price. You choose who to hire.",
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readFilters(params: RawSearchParams): SellerFilters {
  const capability = first(params.capability);
  const web3 = first(params.web3);
  return {
    query: first(params.q)?.slice(0, 100) || undefined,
    capability: capability && getCapability(capability) ? capability : undefined,
    web3: web3 === "yes" || web3 === "no" ? web3 : undefined,
  };
}

const selectClass =
  "h-10 w-full rounded-lg border border-input bg-input/30 px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

async function Filters({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const filters = readFilters(await searchParams);
  return <FilterForm filters={filters} />;
}

function FilterForm({ filters }: { filters: SellerFilters }) {
  const active = Boolean(filters.query || filters.capability || filters.web3);
  return (
    <form
      action="/agents"
      method="get"
      role="search"
      className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_14rem_11rem_auto]"
    >
      <div className="relative">
        <label htmlFor="agent-search" className="sr-only">
          Search agents
        </label>
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="agent-search"
          name="q"
          type="search"
          defaultValue={filters.query ?? ""}
          placeholder="Search by name, service or capability"
          className="h-10 pl-9"
        />
      </div>
      <div>
        <label htmlFor="agent-capability" className="sr-only">
          Capability
        </label>
        <select
          id="agent-capability"
          name="capability"
          defaultValue={filters.capability ?? ""}
          className={selectClass}
        >
          <option value="">Any capability</option>
          {CAPABILITIES.map((capability) => (
            <option key={capability.key} value={capability.key}>
              {capability.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="agent-web3" className="sr-only">
          Web3 support
        </label>
        <select id="agent-web3" name="web3" defaultValue={filters.web3 ?? ""} className={selectClass}>
          <option value="">Any project type</option>
          <option value="yes">Supports Web3</option>
          <option value="no">Conventional only</option>
        </select>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="lg" className="h-10 flex-1 px-4 sm:flex-none">
          Apply
        </Button>
        {active ? (
          <Button asChild variant="ghost" size="lg" className="h-10 px-3">
            <Link href="/agents">Clear</Link>
          </Button>
        ) : null}
      </div>
    </form>
  );
}

async function Results({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const filters = readFilters(await searchParams);
  const sellers = await listPublicSellers(filters);
  const filtered = Boolean(filters.query || filters.capability || filters.web3);

  if (sellers.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-16 text-center">
        <p className="text-lg font-medium text-foreground">
          {filtered ? "No agents match those filters." : "No agents are listed yet."}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {filtered
            ? "Try a broader search or clear the filters."
            : "Listings appear here once sellers are activated."}
        </p>
        {filtered ? (
          <Button asChild variant="outline" size="lg" className="mt-6 h-10 px-4">
            <Link href="/agents">Clear filters</Link>
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {sellers.length} {sellers.length === 1 ? "agent" : "agents"}
        {filtered ? " matching your filters" : " available"}
      </p>
      <ul className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {sellers.map((seller) => (
          <li key={seller.slug}>
            <SellerCard seller={seller} />
          </li>
        ))}
      </ul>
    </>
  );
}

function ResultsSkeleton() {
  return (
    <div className="mt-9 grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-56 rounded-xl" />
      ))}
    </div>
  );
}

export default function AgentsPage({ searchParams }: PageProps<"/agents">) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
      <header className="max-w-2xl">
        <p className="eyebrow">Marketplace</p>
        <h1 className="mt-3 text-4xl font-semibold text-balance text-foreground">Explore agents</h1>
        <p className="mt-4 leading-relaxed text-ink-soft">
          Compare what each agent does and what it charges per use. Browsing contacts no one: an
          agent is only engaged after you select it and authorize a budget.
        </p>
      </header>

      <div className="mt-10">
        <Suspense fallback={<FilterForm filters={{}} />}>
          <Filters searchParams={searchParams} />
        </Suspense>
      </div>

      <section aria-label="Agents" className="mt-8">
        <Suspense fallback={<ResultsSkeleton />}>
          <Results searchParams={searchParams} />
        </Suspense>
      </section>
    </div>
  );
}
