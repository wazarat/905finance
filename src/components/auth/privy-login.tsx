"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { Button } from "@/components/ui/button";

type Phase = "idle" | "exchanging" | "error";

/**
 * Privy sign-in. After Privy authenticates the person in the browser, the
 * access token is sent to the server, which verifies it and issues the
 * application session. Navigation happens only after the server accepts it.
 */
export function PrivyLogin({ next }: { next: string }) {
  const router = useRouter();
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const exchanged = useRef(false);

  const exchange = useCallback(async () => {
    setPhase("exchanging");
    setMessage(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("No access token was issued.");
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await response.json().catch(() => ({}))) as {
        onboarded?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Sign-in failed.");
      router.replace(body.onboarded ? next : "/onboarding");
      router.refresh();
    } catch (error) {
      exchanged.current = false;
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "Sign-in failed.");
    }
  }, [getAccessToken, next, router]);

  useEffect(() => {
    if (ready && authenticated && !exchanged.current) {
      exchanged.current = true;
      void exchange();
    }
  }, [ready, authenticated, exchange]);

  const busy = !ready || phase === "exchanging";

  return (
    <div className="space-y-3">
      <Button
        type="button"
        size="lg"
        className="h-11 w-full text-[0.95rem]"
        disabled={busy}
        onClick={() => (authenticated ? void exchange() : login())}
      >
        {!ready ? "Loading…" : phase === "exchanging" ? "Signing you in…" : "Continue"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">Email, Google or a crypto wallet.</p>
      {phase === "error" && message ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
          <p className="text-destructive">{message}</p>
          <button
            type="button"
            className="mt-1 text-xs text-ink-soft underline underline-offset-2"
            onClick={() => void logout()}
          >
            Use a different account
          </button>
        </div>
      ) : null}
    </div>
  );
}
