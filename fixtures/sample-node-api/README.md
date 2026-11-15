# sample-node-api

A small ordering service used as a test fixture. It is run by the testing
worker; it is not part of the application.

It contains two deliberate defects, each caught by one failing test:

| Defect | Where | Caught by |
|--------|-------|-----------|
| The bulk discount starts at 11 units instead of 10. | `src/cart.ts` | `tests/unit/cart.test.ts` |
| An order of exactly $50.00 is charged shipping instead of shipping free. | `src/checkout.ts` | `tests/regression/checkout.test.ts` |

The API tests in `tests/api` all pass.

It also contains four deliberate security weaknesses, each found by the
security scan (ESLint with `eslint-plugin-security`):

| Weakness | Where |
|----------|-------|
| A merchant-supplied promotion rule is run with `eval`. | `src/promotions.ts` |
| The administrator's token is compared with `===`, which leaks timing. | `src/admin.ts` |
| A receipt is read from a path built from the order id in the request. | `src/receipts.ts` |
| A search pattern is built straight from what the shopper typed. | `src/search.ts` |

None of these modules is used by the tests above.
