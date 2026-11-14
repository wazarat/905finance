import { NextResponse, type NextRequest } from "next/server";
import { getActor } from "@/server/auth/actor";
import { isAppError } from "@/server/errors";
import { QATOM_PENDING_COOKIE } from "@/server/qatom/config";
import { finishQatomConnect, openPending } from "@/server/qatom/connection";

/**
 * Where Qatom sends the owner back after they sign in there. The link is
 * made only if this is the same signed-in owner who started it, and Qatom's
 * answer matches the sign-in that was started.
 */
export async function GET(request: NextRequest) {
  const settings = (outcome: string) => {
    const response = NextResponse.redirect(new URL(`/settings?qatom=${outcome}`, request.url));
    response.cookies.delete({ name: QATOM_PENDING_COOKIE, path: "/api/qatom" });
    return response;
  };
  const params = request.nextUrl.searchParams;
  if (params.get("error")) return settings("cancelled");

  try {
    const actor = await getActor();
    if (!actor) return NextResponse.redirect(new URL("/login?next=%2Fsettings", request.url));
    const pending = await openPending(request.cookies.get(QATOM_PENDING_COOKIE)?.value);
    await finishQatomConnect(actor, pending, { code: params.get("code"), state: params.get("state") });
    return settings("connected");
  } catch (error) {
    if (!isAppError(error)) console.error("Qatom sign-in could not be completed", error);
    return settings("failed");
  }
}
