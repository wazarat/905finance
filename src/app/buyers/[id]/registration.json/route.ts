import { NextResponse, type NextRequest } from "next/server";
import { buyerRegistrationDocument } from "@/server/identity";

/**
 * The ERC-8004 registration document for one organization's buying agent.
 * The address holds the buyer's own unguessable id.
 */
export async function GET(_request: NextRequest, context: RouteContext<"/buyers/[id]/registration.json">) {
  const { id } = await context.params;
  const document = await buyerRegistrationDocument(id);
  if (!document) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(document, { headers: { "cache-control": "public, max-age=60" } });
}
