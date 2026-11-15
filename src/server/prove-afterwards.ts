import "server-only";
import { after } from "next/server";
import { runProofsAndSettle } from "./proofs";

/**
 * Once the response has gone out, fingerprint what is new and write waiting
 * fingerprints to GOAT. Whatever was just recorded is already stored: failing
 * to schedule this must never turn its acceptance into an error.
 */
export function proveAfterwards(): void {
  try {
    after(async () => {
      await runProofsAndSettle();
    });
  } catch {
    // Not inside a request, so there is no response to follow. The next run of proofs picks it up.
  }
}
