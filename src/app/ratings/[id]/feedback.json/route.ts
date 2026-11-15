import { NextResponse, type NextRequest } from "next/server";
import { getRatingDocument } from "@/server/reputation";

/**
 * The public description of one rating, byte for byte what its hash in the
 * Reputation Registry was taken over. It names agents by id, and no person
 * or organization.
 */
export async function GET(_request: NextRequest, context: RouteContext<"/ratings/[id]/feedback.json">) {
  const { id } = await context.params;
  const document = await getRatingDocument(id);
  if (!document) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new NextResponse(document, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
