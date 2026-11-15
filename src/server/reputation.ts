import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getAddress, keccak256, stringToBytes, type Hash } from "viem";
import { z } from "zod";
import { getDb, schema, type DbOrTx } from "@/db/client";
import type { Engagement, EngagementRating, ValidationCase } from "@/db/schema";
import { isEvmAddress, isTxHash } from "@/lib/goat";
import { recordAudit } from "./audit";
import {
  assertAuthenticated,
  findMembership,
  isUuid,
  requirePermission,
  requirePermissionOnRecord,
  roleHasPermission,
  type Actor,
} from "./authz";
import { conflict, forbidden, invalid, notFound } from "./errors";
import { verifyFeedbackTransaction } from "./goat/erc8004";
import { goatLiveConfig } from "./goat/live";
import { goatSigner } from "./goat/signer";
import { hostedUrl } from "./identity";
import { goatFlowTiming } from "./payments/goat-flow";
import { parseInput } from "./validation";

const {
  buyerIdentities,
  buyerProfiles,
  engagementRatings,
  engagementWallets,
  engagements,
  findings,
  organizations,
  purchases,
  sellerIdentities,
  sellerProfiles,
  testingJobs,
  testingResults,
  users,
  validationCases,
} = schema;

/**
 * Reputation and validation.
 *
 * After an engagement, the buyer rates the seller from one to five stars. A
 * rating is given once and never edited. Where the engagement settled on
 * GOAT and the seller has a confirmed ERC-8004 identity, the rating is also
 * written to GOAT's Reputation Registry from the engagement's own wallet;
 * otherwise it is kept by 905 Finance and says so.
 *
 * A rating of one or two stars, or a problem the buyer reports, opens a case
 * for 905 Finance to validate. A case is decided by a 905 Finance operator
 * who belongs to neither side, with a score for the seller's work.
 */

export const LOW_RATING = 2;
/** A rating on ERC-8004's 0 to 100 quality scale: each star is 20. */
export const starsToValue = (stars: number) => BigInt(stars * 20);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const ratingPath = (ratingId: string) => `/ratings/${ratingId}/feedback.json`;

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

const ratingInput = z.object({
  stars: z.coerce.number().int().min(1, "Choose one to five stars.").max(5, "Choose one to five stars."),
  comment: z.string().trim().max(1_000, "Keep the comment under 1,000 characters.").default(""),
});

/** The public description of a rating. It names agents by their ids and nobody by name, and leaves the comment out. */
function feedbackDocument(rating: {
  id: string;
  stars: number;
  sellerAgentId: string | null;
  buyerAgentId: string | null;
  createdAt: Date;
}): string {
  return JSON.stringify({
    type: "905finance.rating.v1",
    rating: rating.id,
    sellerAgentId: rating.sellerAgentId,
    buyerAgentId: rating.buyerAgentId,
    stars: rating.stars,
    value: Number(starsToValue(rating.stars)),
    valueDecimals: 0,
    tag1: "starred",
    tag2: "905finance",
    createdAt: rating.createdAt.toISOString(),
  });
}

/** The feedback document for a rating, for anyone holding its address. */
export async function getRatingDocument(ratingId: string): Promise<string | null> {
  if (!isUuid(ratingId)) return null;
  const [rating] = await getDb().select().from(engagementRatings).where(eq(engagementRatings.id, ratingId));
  return rating ? feedbackDocument(rating) : null;
}

async function hasPaidWork(db: DbOrTx, engagementId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(and(eq(purchases.engagementId, engagementId), inArray(purchases.status, ["paid", "delivered"])))
    .limit(1);
  return Boolean(row);
}

function requestHashOf(input: {
  engagementId: string;
  sellerProfileId: string;
  origin: string;
  reason: string;
  stars: number | null;
  openedAt: Date;
}): string {
  return keccak256(stringToBytes(JSON.stringify({ ...input, openedAt: input.openedAt.toISOString() })));
}

async function openCase(
  tx: DbOrTx,
  engagement: Engagement,
  input: { origin: "low_rating" | "reported"; reason: string; ratingId: string | null; stars: number | null; userId: string },
): Promise<ValidationCase> {
  const openedAt = new Date();
  const [opened] = await tx
    .insert(validationCases)
    .values({
      engagementId: engagement.id,
      organizationId: engagement.organizationId,
      sellerProfileId: engagement.sellerProfileId!,
      ratingId: input.ratingId,
      origin: input.origin,
      reason: input.reason,
      openedBy: input.userId,
      createdAt: openedAt,
      requestHash: requestHashOf({
        engagementId: engagement.id,
        sellerProfileId: engagement.sellerProfileId!,
        origin: input.origin,
        reason: input.reason,
        stars: input.stars,
        openedAt,
      }),
    })
    .returning();
  await recordAudit(
    {
      actorUserId: input.userId,
      organizationId: engagement.organizationId,
      action: "validation.opened",
      entityType: "validation_case",
      entityId: opened.id,
      metadata: { engagementId: engagement.id, origin: input.origin },
    },
    tx,
  );
  return opened;
}

/** Rate the seller for one engagement. Once, by an owner or admin of the buying organization. */
export async function rateEngagement(
  actor: Actor | null,
  engagementId: string,
  rawInput: unknown,
): Promise<{ rating: EngagementRating; caseOpened: ValidationCase | null }> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");
  const input = parseInput(ratingInput, rawInput);
  if (input.stars <= LOW_RATING && input.comment.length < 20) {
    throw invalid("Check the highlighted fields.", {
      comment: ["Say what went wrong, in a sentence or two. A low rating is reviewed by 905 Finance."],
    });
  }

  const saved = await getDb().transaction(async (tx) => {
    const [engagement] = await tx.select().from(engagements).where(eq(engagements.id, engagementId)).for("update");
    await requirePermissionOnRecord(actor, engagement, "engagement.operate", "Engagement", tx);
    if (!engagement.sellerProfileId || !(await hasPaidWork(tx, engagement.id))) {
      throw conflict("Nothing has been bought under this engagement yet, so there is nothing to rate.");
    }
    const [existing] = await tx
      .select({ id: engagementRatings.id })
      .from(engagementRatings)
      .where(eq(engagementRatings.engagementId, engagement.id));
    if (existing) throw conflict("This engagement has already been rated. A rating is given once.");

    const [seller] = await tx
      .select()
      .from(sellerIdentities)
      .where(eq(sellerIdentities.sellerProfileId, engagement.sellerProfileId));
    const [buyer] = await tx
      .select({ identity: buyerIdentities })
      .from(buyerIdentities)
      .innerJoin(buyerProfiles, eq(buyerProfiles.id, buyerIdentities.buyerProfileId))
      .where(eq(buyerProfiles.organizationId, engagement.organizationId));

    const draft = {
      id: randomUUID(),
      stars: input.stars,
      sellerAgentId: seller?.confirmed ? seller.agentId : null,
      buyerAgentId: buyer?.identity.confirmed ? buyer.identity.agentId : null,
      createdAt: new Date(),
    };
    const [rating] = await tx
      .insert(engagementRatings)
      .values({
        ...draft,
        engagementId: engagement.id,
        organizationId: engagement.organizationId,
        sellerProfileId: engagement.sellerProfileId,
        comment: input.comment,
        ratedBy: actor.userId,
        feedbackHash: keccak256(stringToBytes(feedbackDocument(draft))),
      })
      .returning();
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId: engagement.organizationId,
        action: "rating.given",
        entityType: "engagement_rating",
        entityId: rating.id,
        metadata: { engagementId: engagement.id, stars: rating.stars },
      },
      tx,
    );

    let caseOpened: ValidationCase | null = null;
    if (rating.stars <= LOW_RATING) {
      const [open] = await tx
        .select({ id: validationCases.id })
        .from(validationCases)
        .where(and(eq(validationCases.engagementId, engagement.id), eq(validationCases.status, "open")));
      // A problem already reported is the case; a second is not opened beside it.
      if (!open) {
        caseOpened = await openCase(tx, engagement, {
          origin: "low_rating",
          reason: input.comment,
          ratingId: rating.id,
          stars: rating.stars,
          userId: actor.userId,
        });
      }
    }
    return { rating, caseOpened, engagement };
  });

  const rating = await writeRatingToChain(saved.rating, saved.engagement);
  return { rating, caseOpened: saved.caseOpened };
}

async function setRating(id: string, values: Partial<typeof engagementRatings.$inferInsert>): Promise<EngagementRating> {
  const [updated] = await getDb().update(engagementRatings).set(values).where(eq(engagementRatings.id, id)).returning();
  return updated;
}

/**
 * Write a rating to GOAT's Reputation Registry, where that is possible: the
 * engagement has a real wallet on Testnet3 and the seller a confirmed agent.
 * It is sent once. If it cannot be told whether it went out, it is left in
 * doubt and never sent again.
 */
async function writeRatingToChain(rating: EngagementRating, engagement: Engagement): Promise<EngagementRating> {
  const config = goatLiveConfig();
  if (engagement.settlement !== "goat_testnet3" || !rating.sellerAgentId || !config) return rating;
  const [wallet] = await getDb()
    .select()
    .from(engagementWallets)
    .where(eq(engagementWallets.engagementId, engagement.id));
  if (!wallet?.custodyRef || !isEvmAddress(wallet.providerRef)) return rating;

  await setRating(rating.id, { chainStatus: "sending" });
  let hash: Hash;
  try {
    hash = await goatSigner(config).sendFeedback({
      walletId: wallet.custodyRef,
      from: getAddress(wallet.providerRef),
      agentId: BigInt(rating.sellerAgentId),
      value: starsToValue(rating.stars),
      valueDecimals: 0,
      tag1: "starred",
      tag2: "905finance",
      endpoint: "",
      feedbackUri: hostedUrl(ratingPath(rating.id)),
      feedbackHash: rating.feedbackHash as Hash,
    });
  } catch (error) {
    console.error("A rating could not be confirmed as sent to the registry", error);
    return setRating(rating.id, {
      chainStatus: "uncertain",
      chainProblem: "The transaction may or may not have been broadcast. It has not been sent again.",
    });
  }
  await setRating(rating.id, { chainStatus: "sent", chainRef: hash });
  return settleRating(rating.id, true);
}

async function settleRating(ratingId: string, wait: boolean): Promise<EngagementRating> {
  const db = getDb();
  const [rating] = await db.select().from(engagementRatings).where(eq(engagementRatings.id, ratingId));
  if (rating.chainStatus !== "sent" || !isTxHash(rating.chainRef)) return rating;
  const [wallet] = await db
    .select()
    .from(engagementWallets)
    .where(eq(engagementWallets.engagementId, rating.engagementId));
  const deadline = Date.now() + (wait ? goatFlowTiming.chainWaitMs : 0);
  for (;;) {
    let result;
    try {
      result = await verifyFeedbackTransaction({ hash: rating.chainRef, from: getAddress(wallet.providerRef) });
    } catch {
      return rating;
    }
    if (result.ok) return setRating(rating.id, { chainStatus: "confirmed", chainProblem: null });
    if (!result.pending) return setRating(rating.id, { chainStatus: "failed", chainProblem: result.reason });
    if (Date.now() >= deadline) return rating;
    await sleep(goatFlowTiming.pollMs);
  }
}

/** Ask the chain again about a rating that was sent and not yet confirmed. Sends nothing. */
export async function checkRatingOnChain(actor: Actor | null, engagementId: string): Promise<EngagementRating | null> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");
  const [engagement] = await getDb().select().from(engagements).where(eq(engagements.id, engagementId));
  await requirePermissionOnRecord(actor, engagement, "engagement.operate", "Engagement");
  const [rating] = await getDb()
    .select()
    .from(engagementRatings)
    .where(eq(engagementRatings.engagementId, engagement.id));
  return rating ? settleRating(rating.id, false) : null;
}

// ---------------------------------------------------------------------------
// Problems and validation
// ---------------------------------------------------------------------------

const reportInput = z.object({
  reason: z
    .string()
    .trim()
    .min(20, "Describe the problem in a sentence or two.")
    .max(2_000, "Keep the description under 2,000 characters."),
});

/** Put a problem with an engagement to 905 Finance. */
export async function reportProblem(
  actor: Actor | null,
  engagementId: string,
  rawInput: unknown,
): Promise<ValidationCase> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");
  const input = parseInput(reportInput, rawInput);
  return getDb().transaction(async (tx) => {
    const [engagement] = await tx.select().from(engagements).where(eq(engagements.id, engagementId)).for("update");
    await requirePermissionOnRecord(actor, engagement, "engagement.operate", "Engagement", tx);
    if (!engagement.sellerProfileId || !(await hasPaidWork(tx, engagement.id))) {
      throw conflict("Nothing has been bought under this engagement yet, so there is nothing to review.");
    }
    const [open] = await tx
      .select({ id: validationCases.id })
      .from(validationCases)
      .where(and(eq(validationCases.engagementId, engagement.id), eq(validationCases.status, "open")));
    if (open) throw conflict("905 Finance is already reviewing a problem with this engagement.");
    const [rating] = await tx
      .select()
      .from(engagementRatings)
      .where(eq(engagementRatings.engagementId, engagement.id));
    return openCase(tx, engagement, {
      origin: "reported",
      reason: input.reason,
      ratingId: rating?.id ?? null,
      stars: rating?.stars ?? null,
      userId: actor.userId,
    });
  });
}

const responseInput = z.object({
  response: z
    .string()
    .trim()
    .min(10, "Write a sentence or two.")
    .max(2_000, "Keep the response under 2,000 characters."),
});

/** The seller's side of a case, given once while it is open. */
export async function respondToCase(actor: Actor | null, caseId: string, rawInput: unknown): Promise<ValidationCase> {
  assertAuthenticated(actor);
  if (!isUuid(caseId)) throw notFound("Case");
  const input = parseInput(responseInput, rawInput);
  return getDb().transaction(async (tx) => {
    const [found] = await tx.select().from(validationCases).where(eq(validationCases.id, caseId)).for("update");
    const [seller] = found
      ? await tx.select().from(sellerProfiles).where(eq(sellerProfiles.id, found.sellerProfileId))
      : [];
    await requirePermissionOnRecord(actor, seller, "seller_listing.manage", "Case", tx);
    if (found.status !== "open") throw conflict("This case has been decided.");
    if (found.sellerResponse) throw conflict("A response has already been given.");
    const [updated] = await tx
      .update(validationCases)
      .set({ sellerResponse: input.response, sellerRespondedBy: actor.userId, sellerRespondedAt: new Date() })
      .where(eq(validationCases.id, found.id))
      .returning();
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId: seller.organizationId,
        action: "validation.seller_responded",
        entityType: "validation_case",
        entityId: found.id,
      },
      tx,
    );
    return updated;
  });
}

// ---------------------------------------------------------------------------
// The 905 Finance validator
// ---------------------------------------------------------------------------

/** The sign-in addresses of the people who validate for 905 Finance, from the deployment's settings. */
function operatorEmails(): string[] {
  return (process.env.PLATFORM_OPERATOR_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes("@"));
}

/** True when the signed-in person validates for 905 Finance. Decided from the verified sign-in, never from a request. */
export async function isPlatformOperator(actor: Actor | null, db: DbOrTx = getDb()): Promise<boolean> {
  if (!actor || !isUuid(actor.userId)) return false;
  const allowed = operatorEmails();
  if (allowed.length === 0) return false;
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, actor.userId));
  return Boolean(user?.email && allowed.includes(user.email.toLowerCase()));
}

async function requireOperator(actor: Actor | null, db: DbOrTx = getDb()): Promise<Actor> {
  assertAuthenticated(actor);
  // The same answer as for a page that does not exist: the queue is not advertised.
  if (!(await isPlatformOperator(actor, db))) throw notFound("Page");
  return actor;
}

export type CaseSummary = {
  id: string;
  status: ValidationCase["status"];
  origin: string;
  sellerName: string;
  buyerName: string;
  stars: number | null;
  createdAt: Date;
  decidedAt: Date | null;
  score: number | null;
};

/** Every case, open ones first, for a 905 Finance operator. */
export async function listCasesForOperator(actor: Actor | null): Promise<CaseSummary[]> {
  await requireOperator(actor);
  const rows = await getDb()
    .select({
      found: validationCases,
      sellerName: sellerProfiles.displayName,
      buyerName: organizations.name,
      stars: engagementRatings.stars,
    })
    .from(validationCases)
    .innerJoin(sellerProfiles, eq(sellerProfiles.id, validationCases.sellerProfileId))
    .innerJoin(organizations, eq(organizations.id, validationCases.organizationId))
    .leftJoin(engagementRatings, eq(engagementRatings.id, validationCases.ratingId))
    .orderBy(sql`(${validationCases.status} = 'open') desc`, desc(validationCases.createdAt))
    .limit(200);
  return rows.map((row) => ({
    id: row.found.id,
    status: row.found.status,
    origin: row.found.origin,
    sellerName: row.sellerName,
    buyerName: row.buyerName,
    stars: row.stars,
    createdAt: row.found.createdAt,
    decidedAt: row.found.decidedAt,
    score: row.found.score,
  }));
}

export type CaseEvidence = {
  jobId: string;
  capability: string;
  status: string;
  outcome: string | null;
  tool: string | null;
  testsTotal: number | null;
  testsPassed: number | null;
  testsFailed: number | null;
  errorMessage: string | null;
  findings: Array<{ title: string; severity: string; location: string }>;
};

export type CaseDetail = CaseSummary & {
  reason: string;
  comment: string | null;
  sellerResponse: string | null;
  sellerRespondedAt: Date | null;
  verdictNote: string | null;
  requestHash: string;
  /** True when the operator belongs to one of the two sides and so may not decide. */
  conflicted: boolean;
  evidence: CaseEvidence[];
};

/** One case with what the validator needs to decide it: both sides' words and what the tests recorded. */
export async function getCaseForOperator(actor: Actor | null, caseId: string): Promise<CaseDetail> {
  const operator = await requireOperator(actor);
  if (!isUuid(caseId)) throw notFound("Case");
  const db = getDb();
  const [row] = await db
    .select({
      found: validationCases,
      seller: sellerProfiles,
      buyerName: organizations.name,
      rating: engagementRatings,
    })
    .from(validationCases)
    .innerJoin(sellerProfiles, eq(sellerProfiles.id, validationCases.sellerProfileId))
    .innerJoin(organizations, eq(organizations.id, validationCases.organizationId))
    .leftJoin(engagementRatings, eq(engagementRatings.id, validationCases.ratingId))
    .where(eq(validationCases.id, caseId));
  if (!row) throw notFound("Case");

  const jobs = await db
    .select({ job: testingJobs, result: testingResults })
    .from(testingJobs)
    .leftJoin(testingResults, eq(testingResults.jobId, testingJobs.id))
    .where(eq(testingJobs.engagementId, row.found.engagementId))
    .orderBy(testingJobs.createdAt);
  const found =
    jobs.length > 0
      ? await db
          .select({ jobId: findings.jobId, title: findings.title, severity: findings.severity, location: findings.location })
          .from(findings)
          .where(inArray(findings.jobId, jobs.map((entry) => entry.job.id)))
          .orderBy(findings.sequence)
      : [];

  return {
    id: row.found.id,
    status: row.found.status,
    origin: row.found.origin,
    sellerName: row.seller.displayName,
    buyerName: row.buyerName,
    stars: row.rating?.stars ?? null,
    createdAt: row.found.createdAt,
    decidedAt: row.found.decidedAt,
    score: row.found.score,
    reason: row.found.reason,
    comment: row.rating?.comment ?? null,
    sellerResponse: row.found.sellerResponse,
    sellerRespondedAt: row.found.sellerRespondedAt,
    verdictNote: row.found.verdictNote,
    requestHash: row.found.requestHash,
    conflicted: await belongsToEitherSide(operator.userId, row.found.organizationId, row.seller.organizationId, db),
    evidence: jobs.map(({ job, result }) => ({
      jobId: job.id,
      capability: job.capability,
      status: job.status,
      outcome: result?.outcome ?? null,
      tool: result?.tool ?? null,
      testsTotal: result?.testsTotal ?? null,
      testsPassed: result?.testsPassed ?? null,
      testsFailed: result?.testsFailed ?? null,
      errorMessage: result?.errorMessage ?? job.failureReason ?? null,
      findings: found.filter((entry) => entry.jobId === job.id).map(({ title, severity, location }) => ({ title, severity, location })),
    })),
  };
}

async function belongsToEitherSide(userId: string, buyerOrg: string, sellerOrg: string, db: DbOrTx): Promise<boolean> {
  return Boolean((await findMembership(userId, buyerOrg, db)) || (await findMembership(userId, sellerOrg, db)));
}

const verdictInput = z
  .object({
    verdict: z.enum(["upheld", "not_upheld"], { error: "Choose a verdict." }),
    score: z.coerce.number().int().min(0, "Enter a score from 0 to 100.").max(100, "Enter a score from 0 to 100."),
    note: z.string().trim().min(20, "Give the reason for the verdict.").max(2_000, "Keep the reason under 2,000 characters."),
    confirmed: z.literal(true, { error: "Confirm the verdict. It cannot be changed." }),
  })
  .refine((value) => (value.verdict === "upheld" ? value.score < 50 : value.score >= 50), {
    path: ["score"],
    message: "A complaint that stands means a score below 50; one that does not, 50 or above.",
  });

/** The validator's verdict on a case. Final, and never given by someone on either side. */
export async function decideCase(actor: Actor | null, caseId: string, rawInput: unknown): Promise<ValidationCase> {
  assertAuthenticated(actor);
  if (!isUuid(caseId)) throw notFound("Case");
  return getDb().transaction(async (tx) => {
    const operator = await requireOperator(actor, tx);
    const input = parseInput(verdictInput, rawInput);
    const [found] = await tx.select().from(validationCases).where(eq(validationCases.id, caseId)).for("update");
    if (!found) throw notFound("Case");
    const [seller] = await tx.select().from(sellerProfiles).where(eq(sellerProfiles.id, found.sellerProfileId));
    if (await belongsToEitherSide(operator.userId, found.organizationId, seller.organizationId, tx)) {
      throw forbidden("You belong to one of the two sides of this case, so someone else has to decide it.");
    }
    if (found.status !== "open") throw conflict("This case has already been decided.");
    const [updated] = await tx
      .update(validationCases)
      .set({
        status: input.verdict,
        score: input.score,
        verdictNote: input.note,
        decidedBy: operator.userId,
        decidedAt: new Date(),
      })
      .where(eq(validationCases.id, found.id))
      .returning();
    for (const organizationId of [found.organizationId, seller.organizationId]) {
      await recordAudit(
        {
          actorUserId: null,
          organizationId,
          action: "validation.decided",
          entityType: "validation_case",
          entityId: found.id,
          metadata: { verdict: input.verdict, score: input.score },
        },
        tx,
      );
    }
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type EngagementFeedback = {
  rating: EngagementRating | null;
  cases: ValidationCase[];
  canAct: boolean;
  /** Null when the engagement can be rated now; otherwise why not. */
  rateBlockedBy: string | null;
  /** Null when a problem can be reported now; otherwise why not. */
  reportBlockedBy: string | null;
};

/** The buyer's view of the rating and cases for one of its engagements. */
export async function getEngagementFeedback(actor: Actor | null, engagementId: string): Promise<EngagementFeedback> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");
  const db = getDb();
  const [engagement] = await db.select().from(engagements).where(eq(engagements.id, engagementId));
  const membership = await requirePermissionOnRecord(actor, engagement, "engagement.view", "Engagement");
  const [rating] = await db.select().from(engagementRatings).where(eq(engagementRatings.engagementId, engagement.id));
  const cases = await db
    .select()
    .from(validationCases)
    .where(eq(validationCases.engagementId, engagement.id))
    .orderBy(desc(validationCases.createdAt));
  const bought = await hasPaidWork(db, engagement.id);
  return {
    rating: rating ?? null,
    cases,
    canAct: roleHasPermission(membership.role, "engagement.operate"),
    rateBlockedBy: rating ? "Already rated." : bought ? null : "You can rate the seller once something has been bought.",
    reportBlockedBy: cases.some((entry) => entry.status === "open")
      ? "905 Finance is reviewing a problem with this engagement."
      : bought
        ? null
        : "You can report a problem once something has been bought.",
  };
}

export type SellerReputation = {
  ratings: number;
  /** The average, in tenths of a star, or null when nobody has rated yet. */
  averageTenths: number | null;
  /** How many ratings of one star, two stars, and so on up to five. */
  distribution: [number, number, number, number, number];
  /** How many of the ratings are also in GOAT's Reputation Registry. */
  onChain: number;
  cases: { open: number; upheld: number; notUpheld: number };
};

/** What anyone may see of a seller's standing on 905 Finance: counts and an average, no names and no comments. */
export async function getSellerReputation(sellerProfileId: string, db: DbOrTx = getDb()): Promise<SellerReputation> {
  const rated = await db
    .select({ stars: engagementRatings.stars, chainStatus: engagementRatings.chainStatus })
    .from(engagementRatings)
    .where(eq(engagementRatings.sellerProfileId, sellerProfileId));
  const decided = await db
    .select({ status: validationCases.status })
    .from(validationCases)
    .where(eq(validationCases.sellerProfileId, sellerProfileId));
  const distribution: SellerReputation["distribution"] = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const entry of rated) {
    distribution[entry.stars - 1] += 1;
    sum += entry.stars;
  }
  return {
    ratings: rated.length,
    averageTenths: rated.length === 0 ? null : Math.round((sum * 10) / rated.length),
    distribution,
    onChain: rated.filter((entry) => entry.chainStatus === "confirmed").length,
    cases: {
      open: decided.filter((entry) => entry.status === "open").length,
      upheld: decided.filter((entry) => entry.status === "upheld").length,
      notUpheld: decided.filter((entry) => entry.status === "not_upheld").length,
    },
  };
}

export async function getSellerReputationBySlug(slug: string): Promise<SellerReputation | null> {
  const [seller] = await getDb().select().from(sellerProfiles).where(eq(sellerProfiles.slug, slug));
  return seller && seller.status === "active" ? getSellerReputation(seller.id) : null;
}

export type SellerFeedback = {
  reputation: SellerReputation;
  canRespond: boolean;
  ratings: Array<{ id: string; stars: number; comment: string; createdAt: Date; chainStatus: string }>;
  cases: ValidationCase[];
};

/** A seller's own view of what has been said about its listing. Buyers are not named. */
export async function listSellerFeedback(actor: Actor | null, organizationId: string): Promise<SellerFeedback | null> {
  const membership = await requirePermission(actor, organizationId, "seller_listing.view");
  const db = getDb();
  const [seller] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.organizationId, organizationId));
  if (!seller) return null;
  const ratings = await db
    .select()
    .from(engagementRatings)
    .where(eq(engagementRatings.sellerProfileId, seller.id))
    .orderBy(desc(engagementRatings.createdAt))
    .limit(100);
  const cases = await db
    .select()
    .from(validationCases)
    .where(eq(validationCases.sellerProfileId, seller.id))
    .orderBy(desc(validationCases.createdAt))
    .limit(100);
  return {
    reputation: await getSellerReputation(seller.id, db),
    canRespond: roleHasPermission(membership.role, "seller_listing.manage"),
    ratings: ratings.map(({ id, stars, comment, createdAt, chainStatus }) => ({ id, stars, comment, createdAt, chainStatus })),
    cases,
  };
}
