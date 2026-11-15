import { NextResponse, type NextRequest } from "next/server";
import { sellerRegistrationDocument } from "@/server/identity";

/**
 * The ERC-8004 registration document for an active listing. A seller sets
 * this address as its agent's registration on GOAT to tie the agent to the
 * listing. Everything in it is already public on the listing's page.
 */
export async function GET(_request: NextRequest, context: RouteContext<"/agents/[slug]/registration.json">) {
  const { slug } = await context.params;
  const document = await sellerRegistrationDocument(slug);
  if (!document) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(document, { headers: { "cache-control": "public, max-age=60" } });
}
