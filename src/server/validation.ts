import { z } from "zod";
import {
  CAPABILITY_KEYS,
  SETTLEMENT_RAIL,
  railLabel,
  PROJECT_FIXTURE_KEYS,
  getFixture,
} from "@/lib/capabilities";
import { billingUnit, endpointProtocol } from "@/db/schema";
import { invalid, type FieldErrors } from "./errors";

function isHttpUrl(value: string, { httpsOnly }: { httpsOnly: boolean }): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || (!httpsOnly && url.protocol === "http:");
  } catch {
    return false;
  }
}

const httpsUrl = (message: string) =>
  z
    .string()
    .trim()
    .max(2000)
    .refine((v) => isHttpUrl(v, { httpsOnly: true }), message);

const optionalText = (max: number) => z.string().trim().max(max).default("");

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export const roleChoice = z.enum(["buyer", "seller", "both"]);
export type RoleChoice = z.infer<typeof roleChoice>;

export const onboardingInput = z.object({
  displayName: z.string().trim().min(2, "Enter your name.").max(80),
  organizationName: z.string().trim().min(2, "Enter an organization name.").max(80),
  accountType: z.enum(["individual", "business"]),
  roles: roleChoice,
  sellerDisplayName: z.string().trim().max(80).optional(),
});
export type OnboardingInput = z.infer<typeof onboardingInput>;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projectInput = z
  .object({
    name: z.string().trim().min(2, "Give the project a name.").max(80),
    description: optionalText(2000),
    sourceType: z.enum(["repository", "fixture"]),
    repositoryUrl: z.string().trim().max(2000).optional(),
    fixtureKey: z.string().trim().optional(),
    applicationUrl: z.string().trim().max(2000).optional(),
    testingObjectives: optionalText(2000),
    // Both are checked in the refinement below so every problem is reported at once.
    hasWeb3: z.unknown(),
    testingAuthorized: z.unknown(),
  })
  .superRefine((value, ctx) => {
    if (typeof value.hasWeb3 !== "boolean") {
      ctx.addIssue({
        code: "custom",
        path: ["hasWeb3"],
        message: "Answer whether the project includes Web3 components.",
      });
    }
    if (value.sourceType === "repository") {
      if (!value.repositoryUrl || !isHttpUrl(value.repositoryUrl, { httpsOnly: true })) {
        ctx.addIssue({
          code: "custom",
          path: ["repositoryUrl"],
          message: "Enter an https:// repository URL.",
        });
      }
    } else {
      const fixture = value.fixtureKey ? getFixture(value.fixtureKey) : undefined;
      if (!fixture || !(PROJECT_FIXTURE_KEYS as readonly string[]).includes(fixture.key)) {
        ctx.addIssue({ code: "custom", path: ["fixtureKey"], message: "Choose a test fixture." });
      } else if (fixture.web3 && value.hasWeb3 === false) {
        ctx.addIssue({
          code: "custom",
          path: ["hasWeb3"],
          message: "This fixture contains smart contracts, so the answer must be Yes.",
        });
      }
    }
    if (value.applicationUrl && !isHttpUrl(value.applicationUrl, { httpsOnly: false })) {
      ctx.addIssue({
        code: "custom",
        path: ["applicationUrl"],
        message: "Enter a valid http(s) URL or leave this empty.",
      });
    }
    if (value.testingAuthorized !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["testingAuthorized"],
        message: "Confirm that you are authorized to have this project tested.",
      });
    }
  })
  .transform((value) => ({ ...value, hasWeb3: value.hasWeb3 === true, testingAuthorized: true as const }));
export type ProjectInput = z.infer<typeof projectInput>;

// ---------------------------------------------------------------------------
// Seller listing
// ---------------------------------------------------------------------------

export const sellerListingInput = z.object({
  displayName: z.string().trim().min(2, "Enter a seller name.").max(80),
  tagline: optionalText(140),
  description: optionalText(4000),
  capabilities: z.array(z.enum(CAPABILITY_KEYS)).max(CAPABILITY_KEYS.length).default([]),
});
export type SellerListingInput = z.infer<typeof sellerListingInput>;

export const offeringInput = z.object({
  name: z.string().trim().min(2, "Name the offering.").max(80),
  description: optionalText(1000),
  capability: z.enum(CAPABILITY_KEYS, { error: "Choose a capability." }),
  billingUnit: z.enum(billingUnit.enumValues, { error: "Choose a billing unit." }),
  /** Integer minor units. Parsing from user-entered decimals happens before validation. */
  priceMinor: z
    .number({ error: "Enter a price such as 25 or 25.50." })
    .int("Enter a price such as 25 or 25.50.")
    .min(0)
    .max(100_000_000),
});
export type OfferingInput = z.infer<typeof offeringInput>;

export const endpointInput = z.object({
  url: httpsUrl("Enter an https:// endpoint URL."),
  protocol: z.enum(endpointProtocol.enumValues),
});
export type EndpointInput = z.infer<typeof endpointInput>;

// ---------------------------------------------------------------------------
// Engagements
// ---------------------------------------------------------------------------

const uuid = (message: string) =>
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message);

export const engagementInput = z.object({
  sellerSlug: z.string().regex(/^[a-z0-9-]{1,64}$/, "Choose a seller."),
  projectId: uuid("Choose a project."),
});

export const MANDATE_MIN_DAYS = 1;
export const MANDATE_MAX_DAYS = 365;

/**
 * Payments are made on one network. A caller may leave the rail out or name
 * that network; naming any other is an error rather than something to
 * quietly correct.
 */
const settlementRail = z
  .literal(SETTLEMENT_RAIL, { error: `Payments are made on ${railLabel(SETTLEMENT_RAIL)}.` })
  .default(SETTLEMENT_RAIL);

/**
 * A draft mandate as entered. Amounts stay as text here and are converted to
 * exact units in the data layer, where the rail's asset is known.
 */
export const mandateInput = z.object({
  /** Not a choice: present only so that a request naming another network is refused, not ignored. */
  rail: settlementRail,
  totalBudget: z.string().trim().min(1, "Enter a total budget.").max(40),
  perTransactionLimit: z.string().trim().min(1, "Enter a per-purchase limit.").max(40),
  offeringIds: z.array(uuid("Choose valid services.")).min(1, "Permit at least one service.").max(50),
  scope: z.string().trim().min(10, "Describe the testing scope in a sentence or more.").max(2000),
  expiresInDays: z
    .number({ error: "Enter how many days the engagement may run." })
    .int("Enter a whole number of days.")
    .min(MANDATE_MIN_DAYS, `At least ${MANDATE_MIN_DAYS} day.`)
    .max(MANDATE_MAX_DAYS, `At most ${MANDATE_MAX_DAYS} days.`),
});
export type MandateInput = z.infer<typeof mandateInput>;

export const fundingInput = z.object({
  amount: z.string().trim().min(1, "Enter an amount.").max(40),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/, "Reload the page and try again."),
  confirmed: z.literal(true, { error: "Confirm that you authorize this funding." }),
  /** For a real wallet: the transfer the buyer already sent from their own wallet. */
  transactionHash: z.string().trim().max(80).optional(),
});

export const depositInput = z.object({
  rail: settlementRail,
  amount: z.string().trim().min(1, "Enter an amount.").max(40),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse input with a schema, raising an `invalid` AppError carrying per-field messages. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fieldErrors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "_form";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  throw invalid("Check the highlighted fields.", fieldErrors);
}
