# 905 Finance

**Human-selected agents. Autonomous execution. Controlled spending.**

905 Finance is a marketplace where people and businesses hire specialized AI service agents on a pay-per-use basis. A person chooses the seller, sets the budget and authorizes the engagement. Only then does a dedicated purchasing agent buy and run services from that one seller, inside the limits that were set.

The first service family is software testing and smart-contract security. The data model is not tied to it.

## Status

The product was built in seven milestones, one at a time. All seven are built. What still stands between this and a fully live run is outside the code: accounts, credentials and test funds that only the operator can supply. They are listed under [What is not live yet](#what-is-not-live-yet), and the application reports the same thing about itself in **Settings → What is connected**.

| # | Milestone | State |
|---|-----------|-------|
| 1 | Foundation, authentication and marketplace | **Complete** |
| 2 | Engagements and wallet architecture | **Complete** |
| 3 | Purchasing agent and human controls | **Complete** |
| 4 | Real software testing services | **Complete** |
| 5 | Qatom: agent communication | **Built**; live run awaits a Qatom sign-in and catalog items |
| 6 | GOAT Network: ERC-8004 identity and payment | Identity and reputation **live on Testnet3**; wallets and payments **built**, awaiting Privy, a GOAT Flow test merchant and test funds |
| 7 | End-to-end integration and deployment | **Complete** on simulated settlement; deployed. The live Qatom and GOAT runs await the items above |
| 8 | Presentation and security findings | **Complete** |
| 9 | ERC-8004 identity, ratings and validation | **Complete** on the platform; ratings reach GOAT's Reputation Registry once an engagement has a real wallet |
| 10 | Proof on GOAT for every record | **Built**; writing to the chain awaits `GOAT_PROOFS` and a little test BTC in the proof wallet |

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

- Engagements: a buyer selects a seller for a project, and that selection is saved. An engagement has one seller for life, and pays on one network: GOAT.
- A backend-enforced state machine: `DISCOVERING → SELLER_SELECTED → AUTHORIZED → WALLET_PROVISIONED → AWAITING_FUNDING → ACTIVE`, with `PAUSED_FOR_APPROVAL`, `COMPLETED`, `CANCELLED`, `EXPIRED` and `FAILED`.
- Spending mandates: total budget, per-purchase limit, permitted services, testing scope and expiry, drafted freely and then explicitly authorized by the organization's owner.
- One dedicated wallet per engagement, provisioned through a wallet-provider interface.
- A master account, with funding of an engagement wallet as its own explicit, owner-only authorization. Authorizing a mandate never moves funds.
- A wallets page showing the master account and every engagement wallet, with a ledger of every balance change.
- A single gate that decides whether a purchasing agent may contact a seller: only for an ACTIVE engagement, only its selected seller.
- Cancellation and deadline expiry, both of which end the agent's authority and leave any funds in place.

**Test funds are marked as such.** A test wallet is a record kept by the platform; no account, chain or asset exists behind it, and it carries a **Test funds** marker wherever it appears. Real wallets arrived in Milestone 6 behind the same provider interface.

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

### What works today (Milestone 5)

Every engagement uses two networks together, each for one job. They are not alternatives.

| | Job | State |
|---|---|---|
| **Qatom** | Carries the conversation between the buyer's agent and the seller's agent. No money moves through it. | Built and tested against a stand-in for Qatom. Not yet run against Qatom itself. |
| **GOAT Network** | Identifies the seller (ERC-8004) and is where every payment is made, in USD. | See Milestone 6 below. |

- **One settlement network.** A mandate no longer has a payment rail to choose: every engagement pays on GOAT, and a request naming any other network is refused.
- **Linking a Qatom account.** An owner signs in at Qatom (on Qatom's pages, with PKCE); the application stores the resulting tokens encrypted and uses them only to send its agents' messages. Linking authorizes no payment.
- **Messages over Qatom.** Each message is a checkout of the seller's *free* catalog item. Qatom delivers it to the seller's endpoint and hands the answer back in the same call.
- **Signed both ways.** Qatom tells a seller that a message came through Qatom, not who sent it. So every message is signed by the engagement it belongs to, dated, and usable once; every reply is signed and tied to the message it answers. A reply that fails the check is not used.
- **A seller that checks for itself.** The seller's agent accepts an order only after confirming, from the payment reference, that the purchase really was paid.
- **Every message records its carrier.** The engagement page shows whether a message went over Qatom, with Qatom's transaction id, or over the in-app demo channel.

Until a Qatom account is linked and a seller has a catalog item, agents reach the platform's own sellers over the built-in channel, which is marked as such.

### What works today (Milestone 6)

- **ERC-8004 identity, read from GOAT Testnet3.** A seller links its listing to an agent id and supplies nothing else. The owner, the receiving wallet, the registration document and the reputation summary are read from the registries and shown with explorer links. This part is live and needs no credentials.
- **A link has to be returned.** It is confirmed only when the agent's own registration document names the listing. Until then it is an unconfirmed claim: its reputation is not shown and its wallet is never a payment destination. One agent can be linked to one listing.
- **Real settlement, per engagement.** When GOAT Testnet3 settlement is configured and the seller has a confirmed identity with a wallet set in the registry, a new engagement gets a real wallet and pays for real. Otherwise it is simulated. Which one it is, is fixed when the engagement is authorized, in the database as well as in code.
- **One wallet per engagement, held by Privy.** The application never has a private key. It asks Privy to sign one token transfer and broadcasts it itself.
- **Funding by the buyer, confirmed from the chain.** The buyer's funding wallet is their own; the platform cannot move anything out of it. The buyer sends the transfer, then authorizes it with the transaction hash, and it is credited only when the chain shows exactly that amount of that token arriving at that engagement's wallet. One transfer is credited once.
- **Payments through GOAT Flow.** One payment is one GOAT Flow order and one token transfer to the address the order names, which must be the seller's verified wallet, for the approved amount, in the configured token, on Testnet3. If any of that differs, nothing is sent. Success is recorded only after the transfer is read back from the chain.
- **Nothing is retried blind.** Each step of a payment is written down before it is taken. An order whose creation went unanswered, or a transfer that may or may not have been broadcast, is held for reconciliation and never repeated.
- **The recorded balance decides what can be spent,** not the chain balance: tokens sent to a wallet without a funding authorization cannot be spent.

**What is real and what is not.** Identity and reputation reads are real and were checked against Testnet3. Real wallets and payments are complete in code and tested against stand-ins for Privy, GOAT Flow and the chain; they have **not** been run against the real services, because that needs a Privy app secret, an approved GOAT Flow test merchant with a fee balance, and test tokens. Everything is Testnet3: assets there have no monetary value, and the production GOAT Flow API is refused.

### What works today (Milestone 7)

- **Closing an engagement.** The owner can mark an engagement complete, as well as cancel it. Either ends the agent's authority at once and is final.
- **Returning unused funds, on the owner's authorization only.** Ending an engagement moves nothing. What is left in its wallet goes back when the owner says so, in full, once, to where it came from: the simulated master account, or on Testnet3 the buyer's own funding wallet by a token transfer that is confirmed from the chain. It is never moved to another engagement. A return is refused while any payment's outcome is still unknown.
- **A final financial record** for every engagement: what was authorized in, what was paid to the seller, what was returned and what is still held, with each funding, payment and return and its reference. It states whether the figures reconcile, and downloads as JSON.
- **An activity log** for owners and admins: every sensitive action in the organization, who took it and when. Entries are only ever added.
- **Recovery.** A test that was paid for and could not run can be run again at no charge: no new purchase, no payment touched. A payment whose outcome is unknown is reconciled from the provider's record; while it is unresolved, the engagement buys nothing else, so the same work cannot be paid for twice.
- **An honest status panel.** Settings shows, for sign-in, the testing worker, Qatom, GOAT identity and GOAT payments, whether each is live, simulated or off in this deployment, and tells owners which settings are missing. It never shows a value.
- **The whole journey as a test.** `tests/final.test.ts` walks the full demonstration from sign-up to a closed engagement with a real test execution in the middle, proves a second engagement is isolated from the first, and checks each of the eighteen security invariants by name.

### What works today (Milestone 8)

- **Dollars, plainly.** The platform's test balance is shown as USD. In the records it keeps its own code, so it can never be mistaken for a token.
- **No demonstration labels.** The marketplace, engagement pages and reports no longer carry sample or demo tags. What remains is what a person needs to know about money: a **Test funds** marker on wallets and payments that are not on a chain, and the status panel in Settings.
- **A security scan that names the weakness and shows the code.** A new service, sold by Relay QA, runs ESLint with `eslint-plugin-security` over the project's source. The bundled ordering service has four planted weaknesses (code injection through `eval`, a timing-unsafe token comparison, a path built from request input, a search pattern built from user input) and the scan finds all four. The code being scanned cannot switch a rule off.
- **The code behind every finding.** Each finding now carries the lines it points at, read by the worker from the project itself, with the reported lines marked. This applies to failing tests, Slither findings and the security scan alike.

### What works today (Milestone 9)

ERC-8004 has three parts: identity, reputation and validation. All three now have a place in the product.

- **Identity for both sides.** A seller's agent and a buyer's purchasing agent can each be linked to an ERC-8004 agent id on GOAT Testnet3. The id is all anyone types; the owner and registration are read from the chain. One agent cannot be on both sides, or belong to two organizations.
- **A registration document for every agent.** 905 Finance serves an ERC-8004 registration document for each active listing (`/agents/<slug>/registration.json`) and for each buying agent (at an address holding the buyer's own unguessable id). Registering an agent with that address as its registration is what confirms the link: only the agent's owner can set it.
- **Reputation: one to five stars.** Once something has been bought, an owner or admin of the buying organization rates the seller, once per engagement. A rating cannot be edited. Sellers see their ratings with the comments; the public sees an average, a count and the spread, with no names and no comments.
- **Ratings on GOAT.** When the engagement settled on GOAT and the seller has a confirmed agent, the rating is also written to GOAT's Reputation Registry (`giveFeedback`, each star worth 20 on the registry's 0 to 100 scale) from the engagement's own wallet, with the hash of a public document describing it. It is sent once; if it cannot be told whether it went out, it is left in doubt and never sent again. Otherwise the rating is kept by 905 Finance, and says so.
- **Validation by 905 Finance.** A rating of one or two stars, or a problem the buyer reports, opens a case. The seller may reply once. A 905 Finance validator then reads both sides next to the testing worker's own record of what ran, and gives a final verdict: upheld or not, with a score from 0 to 100 for the seller's work and the reason. Both sides see it, and the counts appear on the seller's public page.
- **Who validates.** The people named in `PLATFORM_OPERATOR_EMAILS`, matched against their verified sign-in. To everyone else the queue does not exist. A validator cannot decide a case that involves an organization they belong to.

**What is on a chain and what is not.** Identity is read from GOAT Testnet3 today. Ratings are written there only for engagements with a real wallet, which still needs real settlement to be switched on; that path is tested against stand-ins. GOAT's documentation lists no Validation Registry on Testnet3, so cases and verdicts are recorded by 905 Finance. Each case stores a hash of what was put to the validator, fixed when it is opened.

### What works today (Milestone 10)

- **A fingerprint for every record.** Each confirmed payment, executed funding, returned balance, rating and verdict gets a fingerprint: the keccak256 hash of a short document describing it. The document is kept, so the fingerprint can be computed again by anyone holding it.
- **Written to GOAT Testnet3.** Fingerprints are combined in batches of up to 100. A batch's combined fingerprint (the hash of its members' fingerprints, in order) is written to the chain as the data of a transaction from the platform's proof wallet to itself: the four bytes `905f`, then the 32-byte combined fingerprint.
- **Checked from the chain, every time it is shown.** A record's proof page re-does every step as it loads: the document hashes to the fingerprint, the fingerprint is in the batch, the batch hashes to the combined fingerprint, and the transaction on GOAT carries exactly that and has settled. If any step fails it says which. The proof downloads as a file with what is needed to check it without this application.
- **A proof wallet that can do nothing else.** It is held by Privy, created the first time it is needed, and only ever sends zero-value transactions to itself. It holds no tokens. It needs a little test BTC for network fees; until it has some, records wait.
- **Safe to repeat.** Writing a fingerprint moves nothing, so unlike a payment a failed or doubtful batch is simply written again. One batch is put together at a time, so two are never sent from the wallet at once.

**What a proof proves.** That the record existed in exactly that form when the transaction was made. It does not turn a payment in test funds into a payment on a chain, and the record says which it was. A payment actually made on GOAT has its own transfer as well.

To switch it on, set `GOAT_PROOFS=testnet3` (the Privy credentials must be set too), redeploy, and press **Write waiting proofs to GOAT** on the Transactions page. The proof wallet's address then appears in Settings and on Transactions; send it a little test BTC on GOAT Testnet3.

### What is not live yet

Everything below is built and tested; none of it has been run against the real service. Each needs something only the operator can do.

| What | Why not | What it needs |
|---|---|---|
| Buying a test on the deployed site | Works only while a testing worker is running for it; otherwise sellers decline to quote and no payment is taken. | `WORKER_TOKEN` set on the site, and `pnpm worker:live up` (see [Serving a deployed site](#serving-a-deployed-site)) or the worker image hosted elsewhere |
| Agent messages over Qatom | Tested against a stand-in built from Qatom's published behaviour | A free catalog item per seller in the Qatom dashboard, `QATOM_FULFILMENT_TOKEN` and `QATOM_SELLER_ITEMS`, and the owner signing in at Qatom from Settings |
| Real wallets, payments and fund returns on GOAT Testnet3 | Tested against stand-ins for Privy, GOAT Flow and the chain | `PRIVY_APP_SECRET`, an approved GOAT Flow test merchant with a fee balance whose receiving address is the seller's registry wallet, test tokens, and a little test BTC for network fees |
| A seller other than the two samples answering an agent | Only the sample sellers have a seller-side agent | A third-party seller endpoint that speaks the signed message format |

Other limits, by design for now:

- The purchasing agent is scripted. There is no language model in the loop; the runtime, tools and policy engine it would sit behind are in place.
- Tests run only against the two bundled fixtures. Running a buyer's own repository needs stronger sandboxing than is provided, and is not offered.
- A test that could not run can be re-run free of charge; it is not refunded. A payment to a seller is never reversed by the platform.
- Listing activation is a command-line step. There is no operator console.
- GOAT is Testnet3 only. The application refuses any other chain and the production payment API. Assets there have no monetary value.
- The two seeded sellers, Relay QA and Ledgerproof, are operated by 905 Finance itself. Their agents are answered by the platform, and the tests they sell are executed by the platform's testing worker.

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
| `QATOM_FULFILMENT_TOKEN`, `QATOM_SELLER_ITEMS` | Optional. Turn on the Qatom channel for sample sellers. See [Qatom](#qatom). |
| `QATOM_ACCOUNT_CLIENT_ID`, `QATOM_ACCOUNT_CLIENT_SECRET` | Optional. Let the seller endpoint confirm each delivery with Qatom. |

Secrets live in `.env.local`, which is git-ignored. Never commit them.

### Signing in without Privy credentials

With `AUTH_MODE=dev`, the login page shows a clearly labelled **Development sign-in** that signs you in as any email address, with no password, so the app can be used before a Privy app exists. It is available only when `NODE_ENV` is not `production`; the server refuses to start in production with `AUTH_MODE=dev` set. Once the Privy variables are filled in, Privy sign-in appears on the same page.

### Activating a seller listing

Sellers submit listings for activation; they cannot activate their own. Until an admin review screen exists, a platform operator activates a submitted listing from the command line:

```bash
pnpm seller:activate <slug>
```

## Walking through the demonstration

With the app, the database and a local testing worker running (see below), the whole journey can be done by hand on simulated settlement:

1. Sign in, and onboard as a buyer.
2. Create a project from a bundled fixture, answering the Web3 question.
3. Open **Explore agents**, choose a sample seller, and select it for the project.
4. Set the mandate (for example a $20 budget and a $15 per-purchase limit) and authorize it.
5. Provision the engagement's wallet, add funds to the master account on the **Wallets** page, and authorize funding.
6. Run the agent. It buys a permitted test; the worker executes it, and the result appears on the engagement and under **Test reports**, with the payment under **Transactions**.
7. Run the agent again. The next purchase would exceed the budget, so the engagement pauses and an approval request appears.
8. Read the report, then approve a higher budget under **Approvals**. No funds move.
9. Authorize additional funding on the engagement page, and run the agent again. It resumes.
10. Complete the engagement, return the unused funds, and download the final financial record.

Starting a second engagement with the other sample seller shows a separate wallet and mandate; the **Wallets** page lists both. `pnpm test tests/final.test.ts` runs the same journey automatically.

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

In a container, which is how it is meant to run: a read-only filesystem, no Linux capabilities, an unprivileged user, and memory, CPU and process limits. The image includes Vitest, Foundry, Slither and ESLint with its security rules.

```bash
docker compose --env-file .env.local --profile worker up --build worker
```

Set `WORKER_APP_URL` if the application is not at `http://host.docker.internal:3000`.

Add `--drain` (`node src/main.mjs --drain`) to run the jobs that are waiting and then exit.

### Serving a deployed site

The worker only makes outbound requests, so it can run anywhere that can reach the site, including a laptop. To run it on this machine for the deployed site:

```bash
pnpm worker:live token     # creates .env.worker.live (ignored by git) and copies the token; prints nothing secret
```

Paste the token into the site's environment variables as `WORKER_TOKEN` (Production, Sensitive) and redeploy. Then:

```bash
pnpm worker:live up        # start the container; it restarts with Docker
pnpm worker:live status    # is it running, and does the site accept its token
pnpm worker:live logs
pnpm worker:live down
```

Use a token of its own for a deployed site, not the local development one. While the worker is running, sellers quote and tests can be bought on the site; while it is stopped they decline, and nothing is charged. To host it elsewhere, run the same image with `APP_URL` and `WORKER_TOKEN` set and the same restrictions the compose file applies (read-only filesystem, no capabilities, an unprivileged user).

## Qatom

Qatom is the channel agents talk through. Nothing here needs a language model or any server beyond this application: the application itself is the client of Qatom's master MCP endpoint (`https://mcp.m.todaq.net/mcp`).

```
buyer's agent ── signs message ──▶ agent_checkout(free item) ──▶ Qatom
                                                                  │  POST <seller endpoint>
                                                                  │  Authorization: Bearer <item secret>
                                                                  │  X-Qatom-Transaction-Id: <id>
                                                                  ▼
                              /api/qatom/seller/<slug>: secret ▸ Qatom sale ▸ signature ▸ once only ▸ active engagement
                                                                  │
buyer's agent ◀── verifies signed reply ◀── receipt ◀── Qatom ◀── signed reply
```

### What protects it

- **No money can move through it.** Items are free, an agent here cannot approve anything at Qatom, and a checkout that asks for approval is treated as undelivered. Keep the Qatom agent wallet unfunded and nothing could be charged even by mistake.
- **A delivery is believed only after five checks**: the item's secret; a Qatom transaction (confirmed with Qatom itself when the seller account's credentials are configured); a valid, recent signature from the engagement it names; that neither the transaction nor the message was served before; and that the engagement is active with this seller.
- **Replies are verified, then still treated as untrusted.** A verified reply is the seller's words: the agent runtime validates its shape and the policy engine checks every figure in it against the mandate.
- **Tokens are encrypted at rest** (AES-256-GCM) and never reach a page. Unlinking revokes them at Qatom and deletes them here.
- **No silent fallback.** If Qatom cannot be reached, the message is not delivered and nothing is bought. A paid order that never reached the seller is sent again on the next run, and is run once.

### Setting it up

1. **Seller side** (the Qatom account that lists the items). Generate a secret (`openssl rand -hex 24`) and set it as `QATOM_FULFILMENT_TOKEN`. For each sample seller, print what to enter and create the item in the Qatom dashboard:

   ```bash
   pnpm qatom:item relay-qa "Relay QA" https://your-site.example
   ```

   Then set `QATOM_SELLER_ITEMS` to the item ids (`relay-qa:412,ledgerproof:413`) and redeploy. Optionally set `QATOM_ACCOUNT_CLIENT_ID` and `QATOM_ACCOUNT_CLIENT_SECRET` so every delivery is confirmed with Qatom.
2. **Buyer side.** In the application, open Settings and choose **Connect Qatom**. You are sent to Qatom to sign in with the email of your existing Qatom account; no new account is needed. The first time anyone does this, the application registers itself with Qatom as an OAuth client for its own address.
3. **Check.** Start an engagement with a sample seller and run the agent. The agent panel shows "Messages via Qatom", and each message in the conversation carries its Qatom transaction id.

Qatom may ask for the owner's approval before running even a free item. If it does, the message is not delivered; setting an auto-approve limit in Qatom lets free items through.

## GOAT Network

```
seller ── registers agent (own wallet) ──▶ ERC-8004 Identity Registry (Testnet3)
                                              │  owner, receiving wallet, registration document
905 Finance ── reads only ───────────────────┘  + Reputation Registry summary

buyer's wallet ── sends token ──▶ engagement wallet (Privy)        confirmed from the chain, then credited
engagement wallet ── transfer ──▶ seller's registry wallet         one GOAT Flow order per payment
                                  └── read back from the chain before the purchase counts as paid
```

### Registering an agent

An agent is registered from its owner's own wallet; 905 Finance holds no key to it and does not do it for anyone. The simplest registration is the document 905 Finance serves for the listing or the buying agent (shown on the Listing page and in Settings):

```bash
cast send 0x54B8d8E2455946f2A5B8982283f2359812e815ce "register(string)" "<registration document address>" \
  --rpc-url https://rpc.testnet3.goat.network --private-key <your key>
```

The registry gives the agent an id. Enter that id on the Listing page (for a seller) or in Settings (for a buying agent). Because the agent's registration is the document for exactly that listing or buyer, the link is confirmed at once.

### Linking a seller's identity

1. Register the agent in the Identity Registry on GOAT Testnet3 (`0x54B8d8E2455946f2A5B8982283f2359812e815ce`) from your own wallet. 905 Finance does not register agents or hold a key that could.
2. In its registration document, add this listing to `services` (the listing page shows the exact entry) and make sure `registrations` names the registry and agent id.
3. Enter the agent id on the Listing page. For a sample seller, an operator runs `pnpm seller:identity <slug> <agent-id>`; the same confirmation rule applies.
4. To be paid at a wallet other than the owner's, set it with `setAgentWallet` in the registry. A seller with no wallet set in the registry is not paid.

### Switching on real settlement

Set the GOAT values in `.env.example` (and the Privy credentials). You need:

- a **GOAT Flow test merchant** from https://flow-merchant.testnet3.goat.network: it must be approved, hold a fee balance, and have a receiving address **equal to the seller's registry wallet**, because GOAT Flow pays the merchant's configured address and this application refuses to pay anywhere else;
- the **USD token** that merchant is configured for (its contract address, symbol and decimals);
- **test assets**: the buyer needs that token in their own wallet, and each engagement wallet needs a little test BTC for network fees (it pays its own).

Until all of it is set, every engagement uses test funds, and its wallet and payments are marked **Test funds**.

### What cannot happen

- The application cannot be pointed at a network where assets have value: the chain is checked to be 48816, and only the Testnet3 payment API is accepted.
- An agent cannot choose where money goes. The recipient is fixed when the buyer authorizes the engagement, to the wallet the registry names at that moment.
- A simulated engagement cannot become a real one, or the reverse, after it is authorized.
- A failed or uncertain payment is never retried through another provider, and never re-sent.

## Deploying to Vercel

Import the repository in Vercel, then add these in **Project → Settings → Environment Variables** before the first visit:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | A hosted Postgres connection string. Adding Neon from Vercel's **Storage** tab sets this for you. |
| `SESSION_SECRET` | 32+ random characters (`openssl rand -base64 48`). |
| `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` | From the Privy dashboard, for a Privy app dedicated to this site. |
| `NEXT_PUBLIC_APP_URL` | The deployment's public URL. |
| `GOAT_PROOFS` | Optional. Set to `testnet3` to write every record's fingerprint to GOAT Testnet3. See Milestone 10 above. |
| `PLATFORM_OPERATOR_EMAILS` | Optional. The sign-in email addresses of the people who decide validation cases, separated by commas. Without it, cases wait. |
| `WORKER_TOKEN` | 32+ random characters, shared with the testing worker. Optional: without it, or with no worker running, sellers decline to quote and no test is bought. |

The testing worker does not run on Vercel. Host the worker image somewhere that can reach the site (see [The testing worker](#the-testing-worker)).

In the Privy dashboard, add every origin the site is served from (for example `https://905finance.vercel.app` and `http://localhost:3000`) to the app's **allowed origins**, and enable the sign-in methods you want (email, Google, wallet). If the origin is missing, the Privy sign-in window shows "Something went wrong" and nothing reaches this app's server.

Do **not** set `AUTH_MODE` on Vercel: development sign-in is refused in production.

Environment variables only take effect on the next deployment, so redeploy after adding them.

Production deployments apply pending database migrations during the build and keep the platform's own two seller listings in step with `src/db/seed.ts`. A listing that is not the platform's is never touched. Preview deployments and local builds do neither.

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
| `pnpm seller:identity <slug> <agent-id>` | Link a sample seller to its ERC-8004 agent, reading GOAT Testnet3 |
| `pnpm qatom:item <slug> "<name>" <url>` | Print what to enter in the Qatom dashboard for a seller's catalog item |
| `pnpm worker:live token\|up\|status\|logs\|down` | Run the testing worker on this machine for the deployed site |

## How it is put together

```
src/app/(marketing)/   public pages: landing, marketplace, seller profiles
src/app/(app)/         signed-in pages: dashboards, projects, listing, settings
src/app/login, onboarding, logout, api/auth/session
src/components/        UI primitives (shadcn) and feature components
src/db/                Drizzle schema, client, migration runner, seed
src/server/            authentication, permissions, data-access layer, audit
src/server/wallets/    wallet-provider interface, the test-funds provider and the GOAT provider
src/server/payments/   payment-provider interface and the demo provider
src/server/agent/      agent runtime, brain interface, seller transport and demo seller
src/server/goat/       Testnet3 access, ERC-8004 reads, GOAT Flow client, the signer, guarded document fetch
src/server/identity.ts linking a listing to its on-chain identity
src/server/reputation.ts  star ratings, problems put to 905 Finance, the validator's verdicts
src/server/proofs.ts   fingerprints of records, written to GOAT Testnet3 and checked against it
src/server/closure.ts  completing an engagement, returning unused funds, the final record
src/server/audit-log.ts, status.ts   the activity log; what is live, simulated or off
src/server/qatom/      Qatom account link, signed messages, MCP client, seller endpoint checks
src/server/seller-agent/  the sample sellers' side of a conversation
src/server/testing/    job queue, worker endpoints' logic, reports
src/app/api/worker/    the two endpoints a testing worker calls
worker/                the testing worker: runners for Vitest, Foundry, Slither and the security scan, Dockerfile
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
3. **Provision the wallet.** The engagement gets its own empty wallet.
4. **Authorize funding** (owner). Moves a stated amount from the master account into that wallet. After the mandate, seller, agent and wallet are re-checked, the engagement becomes ACTIVE.

A budget is permission to spend, not money, and a wallet balance is money, not permission. Both will have to cover a purchase.

The rules that matter most are enforced in the database as well as in code, so they hold even if application code is wrong:

- triggers make an engagement's organization, project and seller immutable, fix its rail once authorized, and make terminal states final;
- a wallet row has a unique engagement id and a trigger that forbids reassigning it, so a wallet belongs to exactly one engagement forever;
- composite foreign keys guarantee that a wallet is on its engagement's rail, and that a funding record joins a wallet and a master account on the same rail, for the engagement that owns the wallet;
- balances can never go negative.

Funding uses a per-attempt idempotency key, so a repeated submit cannot fund twice, and a failed transfer is recorded and never retried automatically.

`src/server/wallets/provider.ts` defines the wallet-provider interface. `SimulatedWalletProvider` and `GoatWalletProvider` implement it; which one an engagement uses is fixed when it is authorized.

### Closing, and returning unused funds

An engagement ends by being completed or cancelled by its owner, by reaching its deadline, or by failing. All four revoke the mandate and the agent in the same transaction and are final. None of them moves money: a wallet that still holds funds is marked *closing* and waits.

Returning those funds (`src/server/closure.ts`) is a separate, owner-only authorization with its own confirmation and idempotency key:

- only after the engagement has ended, and only when no payment is still in doubt;
- always the whole remaining balance, and only to the account the funds came from;
- one live return per engagement, enforced by a unique index as well as in code;
- on Testnet3 the transfer's hash is saved before anything waits on it, the return counts only once the chain shows it, and a transfer that may or may not have gone out is marked uncertain and never sent again.

The final record adds up funding, confirmed payments, reservations and returns from the platform's own books and states whether they equal what the wallet holds.

### Purchases and the policy engine

`executePurchase` in `src/server/policy.ts` is the only way a seller is paid. It decides from platform records alone, in this order:

1. the engagement is active, with an authorized mandate, an active agent and an active wallet, and no earlier payment whose outcome is still unknown;
2. the service belongs to the seller selected for the engagement;
3. the recipient is the one fixed in the mandate at authorization, whatever the seller asked for;
4. the service is one the mandate permits;
5. the asset is the mandate's and the amount is exactly the listed price;
6. the per-purchase limit and the remaining budget allow it;
7. the wallet has funds not already promised to another payment;
8. spending capacity is reserved, in the same transaction as the checks;
9. the payment is made through the payment provider;
10. the payment is verified independently;
11. the outcome is recorded.

A failed check blocks the purchase and is recorded. A definite payment failure releases the reservation and is not retried. A payment whose outcome is unknown keeps its reservation, so the capacity cannot be spent twice, until it is reconciled from the provider's record.

The agent (`src/server/agent/`) has exactly two tools: buy a permitted service, and finish. There is no tool that changes a mandate, seller, rail or wallet, and extra fields on a tool call (a price, a recipient, an approval) are refused. What a seller replies is parsed as untrusted data: a seller that quotes a higher price, names a different account, or tells the agent to raise its budget is blocked by the policy engine, not by the agent's good sense.

The database backs this up: a trigger refuses any reservation that would exceed the budget or the per-purchase limit, another refuses any agent or seller message unless the engagement is ACTIVE and the seller is the selected one, payments can only be drawn on the wallet of their own engagement, and confirmed payments cannot be altered.

`src/server/payments/provider.ts` defines the payment-provider interface. `DemoPaymentProvider` implements it today.

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
- every engagement settling on GOAT, a request naming any other network being refused, and the retired rail staying sealed off in code and in the database;
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

- Qatom: linking being the owner's decision alone and refused on any mismatch; tokens encrypted and never shown; refresh spent once under simultaneous use; messages refused when altered, replayed, stale or claimed for another engagement; replies refused when forged, altered or swapped; the seller endpoint closed without its secret, serving each delivery once, and refusing what Qatom does not vouch for; an agent unable to approve anything at Qatom; and no silent change of channel on an outage.

The Qatom suite runs against a stand-in built from Qatom's published behaviour, not against Qatom itself.

- GOAT: the application refusing any chain but Testnet3; a transfer confirmed only when token, sender, recipient and amount all match and it has blocks on top; registration documents never fetched from a private address or through a redirect; a link confirmed only when the agent names the listing, and never payable otherwise; real settlement off unless fully configured; funding credited once, from one wallet, for exactly the transfer the chain shows; a payment sending nothing when GOAT Flow's terms differ from the ones approved; unknown outcomes held rather than repeated; and simulated and real engagements never crossing over.

The GOAT suite runs against stand-ins for the chain, Privy and GOAT Flow. The ERC-8004 reader was also run by hand against real agents on Testnet3.

- The final suite (`tests/final.test.ts`): the complete demonstration from a verified sign-in to a closed engagement, with a real Vitest run in the middle, a blocked purchase, an approved budget, separately authorized funding, a resumed agent, and a final record that reconciles; a second engagement with another seller that shares nothing with the first; each of the eighteen security invariants as its own named check; completion and fund returns, simulated and on Testnet3 stand-ins; re-running a failed test without a second charge; and the activity log and status panel showing only what the viewer may see.

- Reputation and validation: ratings limited to one to five stars, once per engagement, by the buyer's owner or admin, and only after something was bought; low ratings and reported problems opening one case at a time; the seller's single reply; the validator named only by the deployment's settings and invisible to everyone else; a verdict whose score has to agree with it, given once, never by someone on either side; a public reputation that carries no names or comments; registration documents that count only at this application's own address; a buying agent confirmed only by its own registration; and a rating written to GOAT once, from the engagement's wallet, and never re-sent when its outcome is unknown.

- Proofs: one fingerprint per settled record, with private text left out; nothing sent and no wallet made while switched off; one transaction per batch carrying exactly the combined fingerprint; nothing counted as written until the chain has settled it; a failed, rejected or dropped batch written again; each record in one batch only under simultaneous requests; a proof failing its check when the record, its fingerprint or the transaction is altered; and a proof readable only by the organization whose record it is.

The testing suite also **executes the real tools** against the bundled fixtures, through the same worker code and submission path the application uses, and asserts the figures they report (for example, Vitest: 6 tests, 5 passed, 1 failed). The Vitest cases always run; the Foundry and Slither cases run when those tools are on `PATH` and are skipped otherwise.
