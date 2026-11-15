import { NextResponse, type NextRequest } from "next/server";
import { proveAfterwards } from "@/server/prove-afterwards";
import { workerCheckIn } from "@/server/testing/jobs";
import { readWorkerBody, refuseUnlessWorker, workerErrorResponse } from "@/server/testing/worker-auth";

/**
 * A testing worker checks in and asks for work. The reply names a bundled
 * fixture and a test type and nothing else: no engagement, buyer, wallet or
 * credential ever travels to a worker.
 */
export async function POST(request: NextRequest) {
  const refusal = refuseUnlessWorker(request);
  if (refusal) return refusal;
  try {
    const { job, watchesFinished } = await workerCheckIn(await readWorkerBody(request));
    // A watch that ended with its last reading missed has its period report written here.
    if (watchesFinished > 0) proveAfterwards();
    return NextResponse.json({ job });
  } catch (error) {
    return workerErrorResponse(error);
  }
}
