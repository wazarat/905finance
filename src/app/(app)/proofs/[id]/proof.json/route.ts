import { NextResponse, type NextRequest } from "next/server";
import { GOAT_TESTNET3 } from "@/lib/goat";
import { getActor } from "@/server/auth/actor";
import { isAppError } from "@/server/errors";
import { PROOF_PREFIX, getProof } from "@/server/proofs";

/** A record's proof as a file: everything needed to check it without this application. */
export async function GET(_request: NextRequest, context: RouteContext<"/proofs/[id]/proof.json">) {
  const { id } = await context.params;
  try {
    const proof = await getProof(await getActor(), id);
    const body = JSON.stringify(
      {
        kind: proof.record.kind,
        document: proof.record.document,
        fingerprint: proof.record.recordHash,
        batch: proof.batch
          ? {
              fingerprints: proof.batch.hashes,
              position: proof.batch.position,
              combinedFingerprint: proof.batch.root,
              network: GOAT_TESTNET3.name,
              chainId: GOAT_TESTNET3.id,
              transaction: proof.batch.txHash,
              blockNumber: proof.batch.blockNumber,
              from: proof.batch.walletAddress,
              data: proof.batch.data,
            }
          : null,
        howToCheck: [
          "keccak256 of `document`, as UTF-8 text, equals `fingerprint`.",
          "`fingerprint` is one of `batch.fingerprints`.",
          "keccak256 of `batch.fingerprints` joined together, as bytes, equals `batch.combinedFingerprint`.",
          `The transaction's input data on ${GOAT_TESTNET3.name} is ${PROOF_PREFIX} followed by \`batch.combinedFingerprint\`.`,
        ],
      },
      null,
      2,
    );
    return new NextResponse(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="proof-${id}.json"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (isAppError(error)) {
      const status = error.code === "unauthenticated" ? 401 : 404;
      return NextResponse.json({ error: status === 401 ? "Sign in to continue." : "Not found." }, { status });
    }
    throw error;
  }
}
