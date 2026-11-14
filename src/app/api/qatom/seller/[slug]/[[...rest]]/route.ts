import { NextResponse, type NextRequest } from "next/server";
import { handleQatomDispatch } from "@/server/qatom/fulfilment";

const MAX_BODY_BYTES = 16_000;
const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });

/**
 * Where Qatom delivers a message for one of the platform's sample sellers.
 *
 * Qatom may add a segment after the address it was given, so anything under
 * the seller's path is answered. A caller without the item's secret is told
 * there is nothing here. A recognised delivery is always answered 200, with
 * a refusal inside when the message is not acted on, because Qatom shows the
 * buyer nothing of a reply that is not a success.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/qatom/seller/[slug]/[[...rest]]">,
) {
  const { slug } = await context.params;
  const text = await request.text();
  let body: unknown = null;
  if (text.length <= MAX_BODY_BYTES) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  try {
    const outcome = await handleQatomDispatch({
      sellerSlug: slug,
      authorization: request.headers.get("authorization"),
      transactionId: request.headers.get("x-qatom-transaction-id"),
      body,
    });
    if (outcome.kind === "not_found") return notFound();
    return NextResponse.json(outcome.body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Qatom delivery failed", error);
    return NextResponse.json(
      { ok: false, status: "rejected", reason: "The seller could not handle the message just now." },
      { headers: { "cache-control": "no-store" } },
    );
  }
}
