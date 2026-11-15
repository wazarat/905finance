/** A promotion as a merchant configures it. The rule is text such as "subtotal > 5000". */
export type Promotion = { code: string; rule: string; percentOff: number };

/** Whether a promotion applies to an order of this size. */
export function promotionApplies(promotion: Promotion, subtotalCents: number): boolean {
  const check = `(function (subtotal) { return ${promotion.rule}; })(${subtotalCents})`;
  return Boolean(eval(check));
}
