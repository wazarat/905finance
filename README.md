# 905 Finance

**Human-selected agents. Autonomous execution. Controlled spending.**

905 Finance is a marketplace where people and businesses hire specialized AI service agents on a pay-per-use basis. A person chooses the seller, sets the budget and authorizes the engagement. Only then does a dedicated purchasing agent buy and run services from that one seller, inside the limits that were set.

The first service family is software testing and smart-contract security. The data model is not tied to it.

## Status

The product is being built in seven milestones, one at a time.

| # | Milestone | State |
|---|-----------|-------|
| 1 | Foundation, authentication and marketplace | **Complete** |
| 2 | Engagements and wallet architecture | Not started |
| 3 | Purchasing agent and human controls | Not started |
| 4 | Real software testing services | Not started |
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

### What is deliberately not here yet

No engagements, wallets, funding, payments, agent-to-agent communication or test execution exist in Milestone 1. Where those will appear, the interface says "Not yet active" or "Not connected" rather than showing placeholder numbers. The two seeded sellers are illustrative and are labelled **Sample listing** wherever they appear; they cannot be engaged.

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

Secrets live in `.env.local`, which is git-ignored. Never commit them.

### Signing in without Privy credentials

With `AUTH_MODE=dev`, the login page shows a clearly labelled **Development sign-in** that signs you in as any email address, with no password, so the app can be used before a Privy app exists. It is available only when `NODE_ENV` is not `production`; the server refuses to start in production with `AUTH_MODE=dev` set. Once the Privy variables are filled in, Privy sign-in appears on the same page.

### Activating a seller listing

Sellers submit listings for activation; they cannot activate their own. Until an admin review screen exists, a platform operator activates a submitted listing from the command line:

```bash
pnpm seller:activate <slug>
```

## Scripts

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Run the app in development |
| `pnpm build` / `pnpm start` | Production build / serve |
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
src/lib/               capability catalog, money helpers, path helpers
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

### Money

Prices are stored as integer minor units with a currency code. User-entered decimals are parsed with integer arithmetic; no monetary value passes through floating point.

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
- exact integer money handling.
