import { NextResponse, type NextRequest } from "next/server";
import { submitTestingResult } from "@/server/testing/jobs";
import { readWorkerBody, refuseUnlessWorker, workerErrorResponse } from "@/server/testing/worker-auth";

/** A testing worker hands back the report for a job it holds. */
export async function POST(request: NextRequest, context: RouteContext<"/api/worker/jobs/[id]/result">) {
  const refusal = refuseUnlessWorker(request);
  if (refusal) return refusal;
  try {
    const { id } = await context.params;
    const outcome = await submitTestingResult(id, await readWorkerBody(request));
    return NextResponse.json({ ok: true, status: outcome.status });
  } catch (error) {
    return workerErrorResponse(error);
  }
}
