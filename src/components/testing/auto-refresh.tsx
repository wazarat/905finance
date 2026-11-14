"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-reads the page from the server every few seconds while something on it
 * is still in progress. Render it only while that is the case.
 */
export function AutoRefresh({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return null;
}
