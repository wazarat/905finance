"use client";

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";

/**
 * Mounts the Privy provider when an app id is configured. Without one the
 * children render as-is, so the app still works with development sign-in.
 */
export function PrivyBoundary({ appId, children }: { appId: string | null; children: ReactNode }) {
  if (!appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      // Sign-in methods are not listed here on purpose: Privy then offers exactly
      // the methods enabled for the app in its dashboard. Naming one that is not
      // enabled there makes the sign-in window fail.
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#2bff88",
          logo: undefined,
          landingHeader: "Sign in to 905 Finance",
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
