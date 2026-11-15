"use server";

import { refresh } from "next/cache";
import { failureState, type FormState } from "@/server/form-state";
import { requireActionWorkspace } from "@/server/page-context";
import { runProofs } from "@/server/proofs";

/** Fingerprint what is new and write what is waiting to GOAT. Any signed-in member may ask; it moves nothing. */
export async function runProofsAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  let outcome: Awaited<ReturnType<typeof runProofs>>;
  try {
    await requireActionWorkspace();
    outcome = await runProofs();
  } catch (error) {
    return failureState(error);
  }
  refresh();
  switch (outcome.state) {
    case "sent":
      return { ok: true, message: `Sent ${outcome.sent} ${outcome.sent === 1 ? "fingerprint" : "fingerprints"} to GOAT Testnet3.` };
    case "idle":
      return { ok: true, message: "Nothing is waiting. Every record's proof is up to date." };
    case "busy":
      return { ok: true, message: "A batch is being written right now. Check again in a moment." };
    case "off":
      return {
        ok: true,
        message: `${outcome.added === 0 ? "Every record already has its fingerprint" : `Fingerprinted ${outcome.added} ${outcome.added === 1 ? "record" : "records"}`}. Writing fingerprints to GOAT is not switched on for this deployment.`,
      };
    default:
      return { ok: false, message: outcome.detail ?? "The proofs could not be written just now." };
  }
}
