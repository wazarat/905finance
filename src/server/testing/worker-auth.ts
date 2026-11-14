import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { isAppError, type AppError } from "../errors";
import { workerToken } from "../env";

/** Reports carry a test log, so they are larger than ordinary requests, but not unbounded. */
const MAX_BODY_BYTES = 3_000_000;

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Check a request comes from a testing worker. Returns a response to send
 * when it does not. The comparison takes the same time whatever was sent.
 */
export function refuseUnlessWorker(request: NextRequest): NextResponse | null {
  const expected = workerToken();
  if (!expected) {
    return NextResponse.json({ error: "The worker API is not configured." }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!presented || !timingSafeEqual(digest(presented), digest(expected))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  return null;
}

/** The request's JSON body, or undefined when it is missing, malformed or too large. */
export async function readWorkerBody(request: NextRequest): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const STATUS: Record<AppError["code"], number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
};

export function workerErrorResponse(error: unknown): NextResponse {
  if (isAppError(error)) {
    return NextResponse.json({ error: error.message }, { status: STATUS[error.code] });
  }
  console.error("Worker request failed", error);
  return NextResponse.json({ error: "The request could not be handled." }, { status: 500 });
}
