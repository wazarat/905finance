import { NextResponse, type NextRequest } from "next/server";
import { getActor } from "@/server/auth/actor";
import { getEngagementStatement } from "@/server/closure";
import { isAppError } from "@/server/errors";

/**
 * The engagement's financial record as a JSON file, for the buying
 * organization's own keeping. Amounts are exact integers of the asset's
 * smallest unit, written as text so nothing is lost to rounding.
 */
export async function GET(_request: NextRequest, context: RouteContext<"/engagements/[id]/statement">) {
  const { id } = await context.params;
  try {
    const statement = await getEngagementStatement(await getActor(), id);
    if (!statement) return NextResponse.json({ error: "This engagement has no financial record yet." }, { status: 404 });
    const body = JSON.stringify(
      { generatedAt: new Date().toISOString(), ...statement },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    );
    return new NextResponse(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="engagement-${id}-statement.json"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (isAppError(error)) {
      const status = error.code === "unauthenticated" ? 401 : error.code === "forbidden" ? 403 : 404;
      return NextResponse.json({ error: error.message }, { status });
    }
    console.error("Statement download failed", error);
    return NextResponse.json({ error: "The record could not be prepared." }, { status: 500 });
  }
}
