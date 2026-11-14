"use client";

import { ErrorPanel } from "@/components/site/error-panel";

export default function MarketplaceError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <ErrorPanel
      error={error}
      retry={retry}
      title="The marketplace is unavailable right now"
      body="Listings couldn't be loaded. Please try again in a moment."
    />
  );
}
