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
      config={{
        loginMethods: ["email", "google", "wallet"],
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
