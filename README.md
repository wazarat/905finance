# 905 Finance

**Human-selected agents. Autonomous execution. Controlled spending.**

905 Finance is a marketplace where people and businesses hire specialized AI service agents on a pay-per-use basis. A person chooses the seller, sets the budget and authorizes the engagement. Only then does a dedicated purchasing agent buy and run services from that one seller, inside the limits that were set.

The first service family is software testing and smart-contract security. The data model is not tied to it.

## Status

The product is being built in seven milestones, one at a time.

| # | Milestone | State |
|---|-----------|-------|
| 1 | Foundation, authentication and marketplace | **Complete** |
| 2 | Engagements and wallet architecture | **Complete** |
| 3 | Purchasing agent and human controls | **Complete** |
| 4 | Real software testing services | **Complete** |
| 5 | Qatom integration | Not started |
| 6 | GOAT Network and ERC-8004 | Not started |
| 7 | End-to-end integration and deployment | Not started |

### What works today (Milestone 1)

- Sign-in with Privy (email, Google, external wallet), verified on the server, with a persistent session.
- Onboarding as Buyer, Seller or Both. One account, one organization, either or both roles.
- Organizations with owner / admin / member roles and backend permission checks on every operation.
- Projects: one creation form for all software, a Web3 question that configures which kinds of testing apply, and an explicit testing-authorization confirmation.
- Seller listings: private drafts, capabilities, priced service offerings, a private service endpoint, a buyer-eye preview, and submission for activation.
- Public marketplace: browse, search and filter active listings, open a seller profile, select a seller.
- Buyer and seller dashboards.
- An audit trail of sensitive actions.

### What works today (Milestone 2)

- Engagements: a buyer selects a seller for a project, and that selection is saved. An engagement has one seller and one payment rail for life.
- A backend-enforced state machine: `DISCOVERING → SELLER_SELECTED → AUTHORIZED → WALLET_PROVISIONED → AWAITING_FUNDING → ACTIVE`, with `PAUSED_FOR_APPROVAL`, `COMPLETED`, `CANCELLED`, `EXPIRED` and `FAILED`.
- Spending mandates: total budget, per-purchase limit, permitted services, testing scope and expiry, drafted freely and then explicitly authorized by the organization's owner.
- One dedicated wallet per engagement, provisioned through a rail-specific wallet-provider interface.
- A master account per rail, with funding of an engagement wallet as its own explicit, owner-only authorization. Authorizing a mandate never moves funds.
- A wallets page showing master accounts and engagement wallets separately for each rail, with a ledger of every balance change.
- A single gate that decides whether a purchasing agent may contact a seller: only for an ACTIVE engagement, only its selected seller.
- Cancellation and deadline expiry, both of which end the agent's authority and leave any funds in place.

**Everything involving value in Milestone 2 is simulated.** Wallets are records kept by the platform; no account, chain or asset exists behind them, and they are labelled **Simulated** wherever they appear. The provider interface is real; the provider behind it is a stand-in until the Qatom and GOAT integrations are built.

### What works today (Milestone 3)

- A purchasing-agent runtime. A person starts a run; the agent proposes one step at a time as a structured tool call, and the runtime carries out only valid calls to the tools it offers.
- A deterministic policy engine that every purchase goes through, checking the engagement, seller, recipient, service, amount, budget and wallet before anything is reserved or paid.
- Spending reservations, taken atomically, so simultaneous purchases cannot exceed the budget or the wallet.
- Idempotent purchases, payment verification before success is recorded, and reconciliation (never an automatic retry) for payments whose outcome is unknown.
- Approval requests: when a purchase would exceed the budget, the engagement pauses and the owner can approve a higher total, choose different permitted work, decline, or cancel.
- Budget increases that change the budget and nothing else. A wallet shortfall is a separate request, answered only by a separate funding authorization.
- Approvals and Transactions pages, with every payment's provider reference.

**The agent, the seller and the payments are demonstrations.** The agent is a scripted one with no language model. It can run only against the two sample sellers, which are answered by a demo seller inside the application. Payments go through a demo provider that moves nothing; simulated balances are debited in the platform's own ledger.

### What works today (Milestone 4)

- **Real test execution.** A paid purchase becomes a job for a separate testing worker, which runs Vitest, Foundry (`forge build`, unit, fuzz and invariant tests) or Slither and reports what happened.
- Two bundled projects with deliberate defects, in `fixtures/`: a TypeScript ordering service (two off-by-one errors) and a Solidity vault (a reentrancy bug and a fee that can exceed the amount). Each defect is caught by a test that genuinely fails.
- A job queue with leases: a worker claims the oldest job it can run; a job held by a worker that dies goes back in the queue, and is given up on after three attempts.
- Structured results: tests executed, passed, failed and skipped, duration, tool and version, command, exit code and the tool's output, plus findings with severity, location, evidence and a recommendation.
- Test reports: a list of every job, a full report per job with its usage charge and payment reference, and the whole record downloadable as JSON.
- Job status on the engagement page (queued, running, result), updating as the worker reports, and real jobs and findings on the dashboard.
- Nobody pays for a test that cannot run: the seller declines to quote, before any payment, when the project is not a bundled fixture, when no worker is online, or when no worker has the tool that test type needs.

**The test execution is genuine; the payment for it is still simulated.** Every count and finding shown is taken from the testing tool's own machine-readable report. Where a tool has no notion of a test count (compilation, static analysis) the report shows none rather than a zero. A run that could not complete is reported as exactly that, and the purchase is shown as paid but not delivered.

### What is deliberately not here yet

No language-model agent, no real seller endpoint is called and no real payment is made. Tests run only against the two bundled fixtures: running a buyer's own repository needs stronger sandboxing than this milestone provides and is not offered. A purchase whose test could not run is not refunded automatically. Unused funds in a closed engagement's wallet are held; returning them is a later, human-authorized step. The two seeded sellers are illustrative and are labelled **Sample listing** wherever they appear.

## Stack

- **App:** Next.js (App Router, Cache Components), React, TypeScript
- **UI:** Tailwind CSS, shadcn/ui
- **Auth:** Privy, with a server-issued HttpOnly session cookie
- **Database:** PostgreSQL with Drizzle ORM (local Docker Postgres in development; any Postgres such as Neon in production)
- **Tests:** Vitest against an in-process Postgres (PGlite) running the real migrations

## Getting started

Requirements: Node 20+, pnpm, Docker.

```bash
pnpm install
cp .env.example .env.local   # then fill in the values described below
pnpm db:up                   # start local Postgres
pnpm db:migrate              # apply migrations
pnpm db:seed                 # add the two sample sellers
pnpm dev                     # http://localhost:3000
```

### Environment

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string. The default in `.env.example` matches `docker-compose.yml`. |
| `SESSION_SECRET` | Signs the session cookie. At least 32 random characters (`openssl rand -base64 48`). |
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app id, from the Privy dashboard. |
| `PRIVY_APP_SECRET` | Privy app secret. Server only. |
| `AUTH_MODE` | Set to `dev` to enable development sign-in (see below). Leave empty otherwise. |
| `NEXT_PUBLIC_APP_URL` | Public base URL of the app. |
| `WORKER_TOKEN` | Shared secret the testing worker presents. At least 32 random characters (`openssl rand -hex 32`). While it is unset the worker endpoints refuse every request. |

Secrets live in `.env.local`, which is git-ignored. Never commit them.

### Signing in without Privy credentials

With `AUTH_MODE=dev`, the login page shows a clearly labelled **Development sign-in** that signs you in as any email address, with no password, so the app can be used before a Privy app exists. It is available only when `NODE_ENV` is not `production`; the server refuses to start in production with `AUTH_MODE=dev` set. Once the Privy variables are filled in, Privy sign-in appears on the same page.

### Activating a seller listing

Sellers submit listings for activation; they cannot activate their own. Until an admin review screen exists, a platform operator activates a submitted listing from the command line:

```bash
pnpm seller:activate <slug>
```

## The testing worker

Tests are never executed inside the web application. They run in a separate worker (`worker/`), a small Node program with one dependency (Vitest) that knows nothing about the application's code or database.

```
buyer's agent ──pays──▶ purchase ──▶ testing job (queued)
                                         │  POST /api/worker/claim      (worker token)
                                         ▼
                                  testing worker ── runs Vitest / Foundry / Slither
                                         │           in a private copy of the fixture
                                         │  POST /api/worker/jobs/<id>/result
                                         ▼
                              result + findings stored ──▶ purchase delivered ──▶ report
```

What keeps it contained:

- **It holds one credential**, its own worker token. It is never given the database address, the session secret or any wallet or signing key, and it refuses to start if it finds one in its environment.
- **A job names a fixture and a test type, nothing else.** What is actually executed comes from the worker's own table (`worker/src/plans.mjs`); no command, path or argument ever travels from the application to the worker.
- **Each job gets a private copy** of the fixture, deleted afterwards, and runs with a scrubbed environment (the worker token is not passed to the tests), a hard time limit and bounded output.
- **Reports are checked before they are stored.** Counts must add up, a run with failures cannot be reported as passed, and a report must come from the tool the job calls for. A report is text to be read: nothing in it can change a mandate, a budget or an engagement.

### Running it

Set the same `WORKER_TOKEN` for the application (in `.env.local`) and for the worker.

On your machine, using whatever tools are installed (a missing tool just means the worker never claims work that needs it):

```bash
cd worker
APP_URL=http://localhost:3000 WORKER_TOKEN=<the token> node src/main.mjs
```

In a container, which is how it is meant to run: a read-only filesystem, no Linux capabilities, an unprivileged user, and memory, CPU and process limits. The image includes Vitest, Foundry and Slither.

```bash
docker compose --env-file .env.local --profile worker up --build worker
```

Set `WORKER_APP_URL` if the application is not at `http://host.docker.internal:3000`. To serve a deployed site, run the same image anywhere that can reach it, with `APP_URL` set to the site's address and `WORKER_TOKEN` matching the one configured there.

Add `--drain` (`node src/main.mjs --drain`) to run the jobs that are waiting and then exit.

## Deploying to Vercel

Import the repository in Vercel, then add these in **Project → Settings → Environment Variables** before the first visit:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | A hosted Postgres connection string. Adding Neon from Vercel's **Storage** tab sets this for you. |
| `SESSION_SECRET` | 32+ random characters (`openssl rand -base64 48`). |
| `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` | From the Privy dashboard, for a Privy app dedicated to this site. |
| `NEXT_PUBLIC_APP_URL` | The deployment's public URL. |
| `WORKER_TOKEN` | 32+ random characters, shared with the testing worker. Optional: without it, or with no worker running, sellers decline to quote and no test is bought. |

The testing worker does not run on Vercel. Host the worker image somewhere that can reach the site (see [The testing worker](#the-testing-worker)).

In the Privy dashboard, add every origin the site is served from (for example `https://905finance.vercel.app` and `http://localhost:3000`) to the app's **allowed origins**, and enable the sign-in methods you want (email, Google, wallet). If the origin is missing, the Privy sign-in window shows "Something went wrong" and nothing reaches this app's server.

Do **not** set `AUTH_MODE` on Vercel: development sign-in is refused in production.

Environment variables only take effect on the next deployment, so redeploy after adding them.

Production deployments apply pending database migrations during the build and add the two sample sellers if they are missing; an existing listing is never rewritten. Preview deployments and local builds do neither.

If a setting is missing, the server logs which one at startup. Public pages still load; pages that need the missing piece show an error screen or a "not configured" notice instead.

## Scripts

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Run the app in development |
| `pnpm build` / `pnpm start` | Production build / serve. On a Vercel production deployment the build also applies migrations. |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | Generate route types and run the TypeScript compiler |
| `pnpm test` | Run the test suite |
| `pnpm db:up` / `pnpm db:down` | Start / stop local Postgres |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:seed` | Seed the sample sellers (safe to re-run) |
| `pnpm seller:activate <slug>` | Activate a listing awaiting review |

## How it is put together

```
src/app/(marketing)/   public pages: landing, marketplace, seller profiles
src/app/(app)/         signed-in pages: dashboards, projects, listing, settings
src/app/login, onboarding, logout, api/auth/session
src/components/        UI primitives (shadcn) and feature components
src/db/                Drizzle schema, client, migration runner, seed
src/server/            authentication, permissions, data-access layer, audit
src/server/wallets/    wallet-provider interface and the simulated provider
src/server/payments/   payment-provider interface and the demo provider
src/server/agent/      agent runtime, brain interface, seller transport and demo seller
src/server/testing/    job queue, worker endpoints' logic, reports
src/app/api/worker/    the two endpoints a testing worker calls
worker/                the testing worker: runners for Vitest, Foundry and Slither, Dockerfile
fixtures/              the bundled projects with known defects that tests run against
src/lib/               capability and rail catalog, state machine, money and unit helpers
drizzle/               generated SQL migrations
tests/                 Vitest suites
```

### Authentication

1. Privy authenticates the person in the browser.
2. The browser sends the Privy access token to `POST /api/auth/session`.
3. The server verifies the token against Privy's keys, finds or creates the user by the verified Privy user id, and sets a signed, HttpOnly, SameSite=Lax session cookie.
4. Every later request verifies that cookie and re-reads the user from the database.

Nothing identifying the user, their organization or their role is ever accepted from the browser.

### Authorization

All reads and writes go through the data-access layer in `src/server/`. Every function there takes the verified actor and checks organization membership and role before touching data; pages and server actions are thin wrappers and never query the database directly. Server actions derive the organization from the session, not from form fields.

- A record in an organization you don't belong to is reported as *not found*, identical to a record that doesn't exist.
- Public marketplace queries select an explicit list of public columns. Seller endpoint addresses and internal ids are never part of a public response.
- Draft, pending and suspended listings are invisible to the public marketplace and profile routes.
- The edge proxy only redirects signed-out visitors early. It is a convenience, not the security boundary.

### Engagements, mandates and wallets

Activating an engagement takes separate decisions, and no later step is implied by an earlier one:

1. **Select a seller.** A person picks it. Nothing is contacted or created.
2. **Authorize the mandate** (owner). Locks the budget, permitted services, scope and expiry, and creates the purchasing agent in an inactive state. No funds move.
3. **Provision the wallet.** The engagement gets its own empty wallet on its rail.
4. **Authorize funding** (owner). Moves a stated amount from the rail's master account into that wallet. After the mandate, seller, agent and wallet are re-checked, the engagement becomes ACTIVE.

A budget is permission to spend, not money, and a wallet balance is money, not permission. Both will have to cover a purchase.

The rules that matter most are enforced in the database as well as in code, so they hold even if application code is wrong:

- triggers make an engagement's organization, project and seller immutable, fix its rail once authorized, and make terminal states final;
- a wallet row has a unique engagement id and a trigger that forbids reassigning it, so a wallet belongs to exactly one engagement forever;
- composite foreign keys guarantee that a wallet is on its engagement's rail, and that a funding record joins a wallet and a master account on the same rail, for the engagement that owns the wallet;
- balances can never go negative.

Funding uses a per-attempt idempotency key, so a repeated submit cannot fund twice, and a failed transfer is recorded and never retried automatically.

`src/server/wallets/provider.ts` defines the wallet-provider interface. `SimulatedWalletProvider` implements it for both rails today; real providers replace it per rail without touching the engagement logic.

### Purchases and the policy engine

`executePurchase` in `src/server/policy.ts` is the only way a seller is paid. It decides from platform records alone, in this order:

1. the engagement is active, with an authorized mandate, an active agent and an active wallet;
2. the service belongs to the seller selected for the engagement;
3. the recipient is the one fixed in the mandate at authorization, whatever the seller asked for;
4. the service is one the mandate permits;
5. the asset is the mandate's and the amount is exactly the listed price;
6. the per-purchase limit and the remaining budget allow it;
7. the wallet has funds not already promised to another payment;
8. spending capacity is reserved, in the same transaction as the checks;
9. the payment is made through the rail's provider;
10. the payment is verified independently;
11. the outcome is recorded.

A failed check blocks the purchase and is recorded. A definite payment failure releases the reservation and is not retried. A payment whose outcome is unknown keeps its reservation, so the capacity cannot be spent twice, until it is reconciled from the provider's record.

The agent (`src/server/agent/`) has exactly two tools: buy a permitted service, and finish. There is no tool that changes a mandate, seller, rail or wallet, and extra fields on a tool call (a price, a recipient, an approval) are refused. What a seller replies is parsed as untrusted data: a seller that quotes a higher price, names a different account, or tells the agent to raise its budget is blocked by the policy engine, not by the agent's good sense.

The database backs this up: a trigger refuses any reservation that would exceed the budget or the per-purchase limit, another refuses any agent or seller message unless the engagement is ACTIVE and the seller is the selected one, payments can only be drawn on the wallet of their own engagement, and confirmed payments cannot be altered.

`src/server/payments/provider.ts` defines the payment-provider interface. `DemoPaymentProvider` implements it for both rails today.

### Money

Prices are stored as integer minor units with a currency code. Mandate and wallet amounts are stored exactly in the asset's smallest unit (`numeric(78,0)`, surfaced as `bigint`), wide enough for 18-decimal tokens. User-entered decimals are parsed with integer arithmetic; no monetary value passes through floating point.

## Tests

```bash
pnpm test
```

The suite runs the real migrations in an in-process Postgres and exercises the data layer directly. It covers:

- every protected data-layer function rejecting unauthenticated callers;
- isolation between organizations for projects, listings, offerings and endpoints;
- role permissions inside an organization;
- buyer, seller and combined onboarding;
- listing lifecycle: drafts and pending listings never public, sellers unable to self-activate;
- public listing data never containing endpoint addresses or internal identifiers;
- project rules: explicit testing authorization, the Web3 answer, source validation;
- session token integrity (tampering, wrong key, unsigned tokens, expiry) and safe post-login redirects;
- exact integer money handling;
- the engagement state machine: every allowed and forbidden transition, and terminal states being final;
- the mandate, wallet and funding steps each requiring their own explicit, owner-only action;
- wallet isolation: a different wallet per engagement, funding one never touching another, and the database refusing a second wallet, a reassigned wallet or a funding record that names another engagement's wallet;
- rail separation, in code and in the database;
- funding safety: not above the master balance, once per idempotency key, no overdraw from simultaneous requests, nothing moved on provider failure;
- the agent gate staying shut in every state but ACTIVE, for every seller but the selected one, and after cancellation or expiry;
- the seller's organization being unable to see, authorize, fund or cancel a buyer's engagement;
- the policy engine: purchases within the mandate succeed, and each of wrong seller, redirected recipient, unpermitted service, altered price, over-limit, over-budget, underfunded and inactive is blocked;
- the $100 budget, $85 used, $25 proposed demonstration end to end: blocked, approved to $500 with no funds moved, then separately funded and resumed;
- duplicate requests charging once, and simultaneous requests unable to exceed the budget or the wallet;
- failed, unverifiable and unknown-outcome payments never recording success and never retrying;
- approvals being owner-only, and a budget increase changing nothing but the budget;
- the agent runtime: no activity before ACTIVE, only the selected seller, and agents or sellers that try to change the deal being refused;
- testing: the seller declining before payment when a test cannot run; one job per paid purchase; claiming, leases, retries and giving up; reports refused when they contradict themselves, come from the wrong tool or the wrong worker; a report's text being unable to change a mandate; reports readable by the buying organization only; the worker endpoints refusing a missing or wrong token; and the worker passing none of its secrets to the tests it runs.

The testing suite also **executes the real tools** against the bundled fixtures, through the same worker code and submission path the application uses, and asserts the figures they report (for example, Vitest: 6 tests, 5 passed, 1 failed). The Vitest cases always run; the Foundry and Slither cases run when those tools are on `PATH` and are skipped otherwise.
