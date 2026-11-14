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
// Billing units and payment rails (labels only; no rail is live in Milestone 1)
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
 * Payment rails. Each rail has its own accounts and its own asset; value on
 * one rail is never counted as, or moved to, another.
 *
 * `simulatedAsset` is the stand-in unit used while a rail is not really
 * connected. Real asset codes, decimals and token contracts are confirmed
 * against each provider when its integration is built.
 */
export const PAYMENT_RAILS = [
  {
    key: "qatom",
    label: "Qatom",
    asset: "USD-TDN",
    simulatedAsset: { code: "USD-TDN", decimals: 2 },
  },
  {
    key: "goat",
    label: "GOAT Network",
    asset: "GOAT Flow asset",
    simulatedAsset: { code: "SIM-USD", decimals: 2 },
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
