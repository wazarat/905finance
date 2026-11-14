import { describe, expect, it } from "vitest";
import type { EngagementState } from "@/db/schema";
import {
  ENGAGEMENT_STATES,
  TERMINAL_STATES,
  allowedTransitions,
  canTransition,
  isSubjectToExpiry,
  isTerminal,
  permitsAgentCommunication,
  permitsFunding,
} from "@/lib/engagement-state";

describe("engagement state machine", () => {
  it("walks the setup path one step at a time", () => {
    const path: EngagementState[] = [
      "DISCOVERING",
      "SELLER_SELECTED",
      "AUTHORIZED",
      "WALLET_PROVISIONED",
      "AWAITING_FUNDING",
      "ACTIVE",
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("allows no step to be skipped on the way to ACTIVE", () => {
    const setup: EngagementState[] = [
      "DISCOVERING",
      "SELLER_SELECTED",
      "AUTHORIZED",
      "WALLET_PROVISIONED",
      "AWAITING_FUNDING",
    ];
    for (const from of setup) {
      const expected = from === "AWAITING_FUNDING";
      expect(canTransition(from, "ACTIVE"), `${from} -> ACTIVE`).toBe(expected);
    }
    expect(canTransition("DISCOVERING", "AUTHORIZED")).toBe(false);
    expect(canTransition("SELLER_SELECTED", "WALLET_PROVISIONED")).toBe(false);
    expect(canTransition("SELLER_SELECTED", "AWAITING_FUNDING")).toBe(false);
    expect(canTransition("AUTHORIZED", "AWAITING_FUNDING")).toBe(false);
    expect(canTransition("WALLET_PROVISIONED", "ACTIVE")).toBe(false);
  });

  it("never moves backwards along the setup path", () => {
    expect(canTransition("AUTHORIZED", "SELLER_SELECTED")).toBe(false);
    expect(canTransition("SELLER_SELECTED", "DISCOVERING")).toBe(false);
    expect(canTransition("ACTIVE", "AWAITING_FUNDING")).toBe(false);
    expect(canTransition("ACTIVE", "AUTHORIZED")).toBe(false);
  });

  it("pauses and resumes only between ACTIVE and PAUSED_FOR_APPROVAL", () => {
    expect(canTransition("ACTIVE", "PAUSED_FOR_APPROVAL")).toBe(true);
    expect(canTransition("PAUSED_FOR_APPROVAL", "ACTIVE")).toBe(true);
    expect(canTransition("AWAITING_FUNDING", "PAUSED_FOR_APPROVAL")).toBe(false);
  });

  it("makes every terminal state final", () => {
    for (const terminal of TERMINAL_STATES) {
      expect(isTerminal(terminal)).toBe(true);
      expect(allowedTransitions(terminal)).toEqual([]);
      for (const to of ENGAGEMENT_STATES) {
        expect(canTransition(terminal, to), `${terminal} -> ${to}`).toBe(false);
      }
    }
  });

  it("lets every non-terminal state be cancelled", () => {
    for (const state of ENGAGEMENT_STATES) {
      expect(canTransition(state, "CANCELLED"), state).toBe(!isTerminal(state));
    }
  });

  it("applies the deadline only once an engagement has been authorized", () => {
    expect(isSubjectToExpiry("DISCOVERING")).toBe(false);
    expect(isSubjectToExpiry("SELLER_SELECTED")).toBe(false);
    for (const state of [
      "AUTHORIZED",
      "WALLET_PROVISIONED",
      "AWAITING_FUNDING",
      "ACTIVE",
      "PAUSED_FOR_APPROVAL",
    ] as const) {
      expect(isSubjectToExpiry(state), state).toBe(true);
    }
  });

  it("permits agent communication in exactly one state", () => {
    for (const state of ENGAGEMENT_STATES) {
      expect(permitsAgentCommunication(state), state).toBe(state === "ACTIVE");
    }
  });

  it("permits funding only once a wallet exists and the engagement is open", () => {
    const fundable = ENGAGEMENT_STATES.filter(permitsFunding);
    expect(fundable).toEqual(["AWAITING_FUNDING", "ACTIVE", "PAUSED_FOR_APPROVAL"]);
  });

  it("has no transition that refers to an unknown state", () => {
    for (const from of ENGAGEMENT_STATES) {
      for (const to of allowedTransitions(from)) {
        expect(ENGAGEMENT_STATES).toContain(to);
        expect(to).not.toBe(from);
      }
    }
  });
});
