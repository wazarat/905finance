"use client";

import { useEffect, useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { signOut } from "@/app/login/actions";
import { PrivyBoundary } from "@/components/auth/privy-boundary";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || null;

/** Ends the Privy browser session first, so the login page doesn't sign straight back in. */
function PrivySignOutRunner() {
  const { ready, logout } = usePrivy();
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    void logout()
      .catch(() => undefined)
      .then(() => signOut());
  }, [ready, logout]);
  return null;
}

function SessionSignOutRunner() {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void signOut();
  }, []);
  return null;
}

/** Clears the application session, and the Privy browser session when Privy is in use. */
export function SignOut() {
  if (!PRIVY_APP_ID) return <SessionSignOutRunner />;
  return (
    <PrivyBoundary appId={PRIVY_APP_ID}>
      <PrivySignOutRunner />
    </PrivyBoundary>
  );
}
