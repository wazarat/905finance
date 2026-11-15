import { NextResponse, after, type NextRequest } from "next/server";
import { runProofsAndSettle } from "@/server/proofs";
import { submitTestingResult } from "@/server/testing/jobs";
import { readWorkerBody, refuseUnlessWorker, workerErrorResponse } from "@/server/testing/worker-auth";

/**
 * Once the response has gone out, take the new report's fingerprint and write
 * waiting fingerprints to GOAT. The report is already stored: failing to
 * schedule this must never turn its acceptance into an error.
 */
function proveAfterwards(): void {
  try {
    after(async () => {
      await runProofsAndSettle();
    });
  } catch {
    // Not inside a request, so there is no response to follow. The next run of proofs picks the report up.
  }
}

/** A testing worker hands back the report for a job it holds. */
export async function POST(request: NextRequest, context: RouteContext<"/api/worker/jobs/[id]/result">) {
  const refusal = refuseUnlessWorker(request);
  if (refusal) return refusal;
  try {
    const { id } = await context.params;
    const outcome = await submitTestingResult(id, await readWorkerBody(request));
    if (!outcome.replayed) proveAfterwards();
    return NextResponse.json({ ok: true, status: outcome.status });
  } catch (error) {
    return workerErrorResponse(error);
  }
}
