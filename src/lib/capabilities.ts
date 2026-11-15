/**
 * Capability catalog.
 *
 * Capabilities are plain string keys stored on seller listings and offerings,
 * so the marketplace is not tied to software testing: adding a new service
 * family (inference, document processing, monitoring…) means adding entries
 * here, not changing the data model.
 */

export type CapabilityDomain = "software_testing";

export type Capability = {
  key: string;
  label: string;
  description: string;
  domain: CapabilityDomain;
  /** True when the capability only applies to projects with Web3 components. */
  web3: boolean;
};

export const CAPABILITIES = [
  {
    key: "unit_testing",
    label: "Unit testing",
    description: "Runs the project's unit test suite and reports pass/fail per test.",
    domain: "software_testing",
    web3: false,
  },
  {
    key: "regression_testing",
    label: "Regression testing",
    description: "Re-runs established suites to catch behaviour that changed between revisions.",
    domain: "software_testing",
    web3: false,
  },
  {
    key: "functional_qa",
    label: "Functional QA",
    description: "Exercises user-facing flows against expected outcomes.",
    domain: "software_testing",
    web3: false,
  },
  {
    key: "api_testing",
    label: "API testing",
    description: "Contract and behaviour checks against approved API fixtures.",
    domain: "software_testing",
    web3: false,
  },
  {
    key: "security_scan",
    label: "Security scan",
    description: "Static analysis of application code for injection, traversal and other security weaknesses.",
    domain: "software_testing",
    web3: false,
  },
  {
    key: "dependency_checks",
    label: "Dependency checks",
    description: "Flags known-vulnerable or outdated dependencies where supported.",
    domain: "software_testing",
    web3: false,
  },
  {
    key: "solidity_compilation",
    label: "Solidity compilation",
    description: "Compiles contracts and reports compiler errors and warnings.",
    domain: "software_testing",
    web3: true,
  },
  {
    key: "foundry_unit",
    label: "Foundry unit tests",
    description: "Runs Forge unit tests against the contract suite.",
    domain: "software_testing",
    web3: true,
  },
  {
    key: "foundry_fuzz",
    label: "Foundry fuzz tests",
    description: "Property-based fuzzing of contract functions with Forge.",
    domain: "software_testing",
    web3: true,
  },
  {
    key: "invariant_testing",
    label: "Invariant testing",
    description: "Stateful invariant campaigns across sequences of contract calls.",
    domain: "software_testing",
    web3: true,
  },
  {
    key: "slither_static_analysis",
    label: "Slither static analysis",
    description: "Static analysis of Solidity sources for known vulnerability patterns.",
    domain: "software_testing",
    web3: true,
  },
  {
    key: "solidity_review",
    label: "Solidity pattern review",
    description: "A first read of Solidity source for risky constructs, without compiling it.",
    domain: "software_testing",
    web3: true,
  },
  {
    key: "contract_check",
    label: "Contract first look",
    description: "What the chain and its explorer say about a deployed contract: who can change it, and whether its source is published.",
    domain: "software_testing",
    web3: true,
  },
  {
    key: "website_check",
    label: "Website first look",
    description: "A passive check of a website's security settings, as a visitor's browser sees them.",
    domain: "software_testing",
    web3: false,
  },
] as const satisfies readonly Capability[];

export type CapabilityKey = (typeof CAPABILITIES)[number]["key"];

export const CAPABILITY_KEYS = CAPABILITIES.map((c) => c.key) as [CapabilityKey, ...CapabilityKey[]];

const byKey = new Map<string, Capability>(CAPABILITIES.map((c) => [c.key, c]));

export function getCapability(key: string): Capability | undefined {
  return byKey.get(key);
}

export function capabilityLabel(key: string): string {
  return byKey.get(key)?.label ?? key.replaceAll("_", " ");
}

export function isWeb3Capability(key: string): boolean {
  return byKey.get(key)?.web3 ?? false;
}

/**
 * Capabilities that apply to a project. Standard capabilities always apply;
 * Web3 capabilities are added when the project declares Web3 components.
 */
export function capabilitiesForProject(hasWeb3: boolean): Capability[] {
  return CAPABILITIES.filter((c) => hasWeb3 || !c.web3);
}

export const STANDARD_CAPABILITIES: Capability[] = CAPABILITIES.filter((c) => !c.web3);
export const WEB3_CAPABILITIES: Capability[] = CAPABILITIES.filter((c) => c.web3);

// ---------------------------------------------------------------------------
// Billing units, and the two networks an engagement runs on
// ---------------------------------------------------------------------------

export const BILLING_UNIT_LABELS = {
  per_run: "per run",
  per_test_suite: "per test suite",
  per_contract: "per contract",
  per_endpoint: "per endpoint",
  per_1k_loc: "per 1k lines",
  per_hour: "per hour",
} as const;

/**
 * Every engagement uses two networks together, each for one job. They are
 * not alternatives, and neither does the other's work:
 *
 * - Qatom carries the conversation between the buyer's agent and the
 *   seller's agent. No money moves through it.
 * - GOAT Network identifies the seller (ERC-8004) and is where every payment
 *   is made, in a USD asset.
 */
export const NETWORK_ROLES = {
  communication: {
    name: "Qatom",
    role: "Agent communication",
    detail: "Carries requests and results between your agent and the seller's agent. No money moves through it.",
  },
  settlement: {
    name: "GOAT Network",
    role: "Identity and payment",
    detail: "Identifies the seller (ERC-8004) and is where every payment is made, in USD.",
  },
} as const;

/** The one network payments are made on. Every new engagement settles here. */
export const SETTLEMENT_RAIL = "goat" as const;

/**
 * Accounting rails. Each has its own accounts and its own asset; value on
 * one is never counted as, or moved to, another.
 *
 * Only the settlement rail can be chosen. `qatom` remains as a key so that
 * records made while it was offered as a simulated payment rail stay
 * readable: nothing new is created on it.
 *
 * `simulatedAsset` is the stand-in unit used until the network is really
 * connected. The real asset code, decimals and token contract are confirmed
 * against GOAT when that integration is built.
 */
export const PAYMENT_RAILS = [
  {
    key: "goat",
    label: "GOAT Network",
    asset: "USD asset on GOAT",
    simulatedAsset: { code: "SIM-USD", decimals: 2 },
    retired: false,
  },
  {
    key: "qatom",
    label: "Earlier account",
    asset: "USD-TDN",
    simulatedAsset: { code: "USD-TDN", decimals: 2 },
    retired: true,
  },
] as const;

export type PaymentRailKey = (typeof PAYMENT_RAILS)[number]["key"];
export const PAYMENT_RAIL_KEYS = PAYMENT_RAILS.map((r) => r.key) as [
  PaymentRailKey,
  ...PaymentRailKey[],
];

export function getRail(key: string) {
  return PAYMENT_RAILS.find((r) => r.key === key);
}

export function isPaymentRail(key: unknown): key is PaymentRailKey {
  return typeof key === "string" && (PAYMENT_RAIL_KEYS as readonly string[]).includes(key);
}

export function railLabel(key: string): string {
  return PAYMENT_RAILS.find((r) => r.key === key)?.label ?? key;
}

// ---------------------------------------------------------------------------
// Bundled test fixtures (the fixtures themselves ship with the testing worker)
// ---------------------------------------------------------------------------

export const PROJECT_FIXTURES = [
  {
    key: "sample-node-api",
    label: "Sample Node API",
    description: "A small TypeScript service with a deliberately failing test.",
    web3: false,
  },
  {
    key: "sample-solidity-vault",
    label: "Sample Solidity vault",
    description: "A Foundry project containing a contract with a known defect.",
    web3: true,
  },
] as const;

export type ProjectFixtureKey = (typeof PROJECT_FIXTURES)[number]["key"];
export const PROJECT_FIXTURE_KEYS = PROJECT_FIXTURES.map((f) => f.key) as [
  ProjectFixtureKey,
  ...ProjectFixtureKey[],
];

export function getFixture(key: string) {
  return PROJECT_FIXTURES.find((f) => f.key === key);
}
