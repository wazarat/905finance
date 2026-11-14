# sample-node-api

A small ordering service used as a test fixture. It is run by the testing
worker; it is not part of the application.

It contains two deliberate defects, each caught by one failing test:

| Defect | Where | Caught by |
|--------|-------|-----------|
| The bulk discount starts at 11 units instead of 10. | `src/cart.ts` | `tests/unit/cart.test.ts` |
| An order of exactly $50.00 is charged shipping instead of shipping free. | `src/checkout.ts` | `tests/regression/checkout.test.ts` |

The API tests in `tests/api` all pass.
