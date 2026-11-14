"use client";

import { ErrorPanel } from "@/components/site/error-panel";

export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorPanel error={error} retry={retry} />;
}
