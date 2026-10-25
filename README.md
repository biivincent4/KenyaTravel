# Sanaa Kenya — travel agency MVP

A responsive, single-agency Kenya travel platform: Google or password sign-in, curated destinations, private saved itineraries, catalog-grounded AI enquiries/planning, quote requests, an authenticated agency workspace and Stripe **test-mode** hosted checkout. “Sanaa Kenya” is a provisional brand. Content, photographs and rates are illustrative; this is not a production travel service.

## Run locally (Windows PowerShell)

Requires Node.js **22.13 or newer** with built-in `node:sqlite` (verified with Node 22 LTS) and npm. No PostgreSQL installation, paid cloud resource or external account is needed for curated planning.

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

Open http://localhost:3000. Use the same hostname as `APP_URL` (`localhost`, not `127.0.0.1`) so the origin protection accepts form submissions. For another port, change `APP_URL` and pass `-- --port 3001` to the dev/start command.

The durable SQLite database is created at `data\sanaa.sqlite`, with WAL journaling, foreign keys and schema initialization on first use. Five destinations and three curated routes seed automatically, without replacing agency edits. Keep the database **and its WAL/SHM files** together while the app is running; use SQLite's backup API or stop the app before making a file copy. This is a **single-host local MVP**, not a serverless or horizontally scaled database design. PostgreSQL is a recommended migration for a multi-instance production release.

## Try the complete workflow

1. Browse Destinations or Our journeys, then choose a curated journey.
2. Enter travel dates (2–14 days), party size (1–12), total party budget/currency (USD or KES) and interests. Curated journeys require their stated duration. Register a customer account with a unique 12+ character password, then save the itinerary.
3. Review the day-by-day schedule and server-calculated illustrative estimate. Request an agency quote; the request remains **requested**, not confirmed or paid.
4. Provision an administrator, sign in separately, and open **Agency workspace**. Review the submitted itinerary and preferences. Check availability and terms **outside the app**, then issue a quote with a total amount, currency, expiry, inclusions/exclusions and cancellation terms. Respond to enquiries and edit catalog descriptions/visibility here too.
5. In the traveller's **My trips**, refresh to see the quote. With Stripe configured, accept the quote and open hosted **test** checkout. Without configuration, the quote stays saved and checkout clearly states it is unavailable.
6. Only a signed, verified provider webhook can mark the booking **paid**. Returning from the checkout URL never does so. A test payment is not a live travel reservation or supplier booking.

### Provision real agency access

No default administrator, hard-coded credential or public admin elevation exists. Customer registration always creates a customer, even if a client sends a different role.

```powershell
# Use your own agency email and a newly generated unique password (16–128 characters).
$env:ADMIN_EMAIL = "agency@example.test"
$env:ADMIN_PASSWORD = "<your-unique-local-development-password>"
# If you changed DATABASE_PATH, set it here too; this CLI does not load .env.local.
npm run admin:create
Remove-Item Env:\ADMIN_PASSWORD
Remove-Item Env:\ADMIN_EMAIL
```

Sign in through the ordinary Sign in dialog. Existing accounts are never silently promoted or overwritten. Password accounts do not yet have app-managed email verification or password reset, and no outgoing email integration is connected. Google emails are verified through the provider when Google sign-in is configured. Replies and quotes are viewed in the app; do not use this local release for real customers yet.

## Google account sign-in

Email/password login still works unchanged. **Continue with Google** appears in both Sign in and Create account; it stays disabled with a setup explanation until the server is configured. No Google account or cloud project is created automatically.

1. In [Google Cloud Console](https://console.cloud.google.com/), select your own project and configure **Google Auth Platform** branding, audience/consent screen and test users. Request only OpenID/email/basic profile access; this app does not request Gmail, Drive or Calendar access. For a consent screen in testing mode, add the Google accounts you intend to test with.
2. Create an OAuth client with application type **Web application**, not Desktop or Android. If the console requests an authorized JavaScript origin, use **`http://localhost:3000`**. This app uses a server-side redirect flow, not a browser Google SDK.
3. Add this exact **Authorized redirect URI** (no hash or trailing slash): **`http://localhost:3000/api/auth/google/callback`**.
4. Put your own credentials into `.env.local`, never chat or source control:

   ```dotenv
   APP_URL=http://localhost:3000
   GOOGLE_CLIENT_ID=<your-web-client-id>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<your-web-client-secret>
   ```

5. Restart the app, choose **Continue with Google**, and consent using an allowed test account. The server exchanges the authorization code and verifies the signed Google ID token before issuing the app's ordinary HttpOnly session. Closing or cancelling the Google flow produces a visible error without signing anyone in.

`APP_URL` must be the app's origin only, with no path, query, username or fragment. The callback is always **`{APP_URL}/api/auth/google/callback`**. If you deliberately use port 3001, register **`http://localhost:3001/api/auth/google/callback`** and set `APP_URL=http://localhost:3001`. If you deliberately use `127.0.0.1`, register **`http://127.0.0.1:3000/api/auth/google/callback`** and set `APP_URL=http://127.0.0.1:3000`; do not mix hostnames midway through sign-in. Testing on a different port also requires its own exact registered callback.

Production requires **HTTPS**: for example, `APP_URL=https://travel.example.com` with the authorized redirect URI **`https://travel.example.com/api/auth/google/callback`** (replace this illustrative hostname with your real domain). Non-local HTTP origins are rejected. HTTPS automatically enables Secure session/OAuth cookies; terminate HTTPS correctly at your hosting layer and register only your controlled domains. Review Google's consent-screen publishing/domain-verification requirements and your privacy/support pages before real users. Never expose `GOOGLE_CLIENT_SECRET` through a `NEXT_PUBLIC_` variable. OAuth credential/model/payment secrets stay separate.

### Existing accounts and agency safeguards

- A first-time, verified Google identity creates a **customer** account with no password login. Its stable Google `sub` identifies future logins; it never receives an agency role from Google profile data.
- If a Google email matches an existing password account, the app **does not automatically merge or link it**. Sign in using the existing password, open **My trips → Account sign-in**, enter the current account password, then choose **Connect Google account**. The Google account must have the **same verified email**. The existing user ID, password, saved plans, bookings and role are preserved.
- Account linking is bound to the authenticated browser session and requires password reauthentication. Signing out invalidates pending linking attempts. One Google identity cannot attach to two accounts, and an already connected Google account cannot be silently replaced.
- A provisioned agency administrator may explicitly connect their matching Google identity with their existing password, but Google sign-up never creates/promotes an administrator. Agency APIs retain their server-side role checks.
- OAuth uses a ten-minute, single-use server-side state record, an HttpOnly/SameSite browser-binding cookie, PKCE S256 and an ID-token nonce. Signature/JWKS, issuer, audience/authorized party, token age/expiry, verified email and subject are checked. Redirects use only allowlisted app sections, never arbitrary return URLs.
- Google access/refresh tokens are not persisted and the app requests no offline access. Only the identity-to-user relationship is stored. Google profile changes do not automatically rewrite an existing account's local email, name or role.

Without your real OAuth client credentials, provider consent/code exchange cannot be verified against Google. The local checks use cryptographically signed fixture tokens and provider-independent OAuth flow tests; they are not a claim of a working Google client registration.

## Connect real AI

Choose **one** server-side provider with `AI_PROVIDER=openai` or `AI_PROVIDER=azure` in `.env.local`, then restart. Omitting `AI_PROVIDER` preserves the original direct OpenAI behavior. Invalid/incomplete selected-provider configuration visibly disables AI; neither missing credentials nor provider/quota errors cause a silent switch to another provider.

### Direct OpenAI

Set `AI_PROVIDER=openai`, `OPENAI_API_KEY` and `OPENAI_MODEL`. The configured model must support Chat Completions tool calls and strict structured JSON outputs (for example, `gpt-4.1-mini`, subject to your account's access). Existing direct OpenAI credentials remain supported and are not changed by selecting Azure.

### Azure OpenAI / Microsoft Foundry

Use a resource-level Azure OpenAI model deployment. A hosted agent, Foundry project, search index or separate agent runtime is **not** required for this app's catalog tool.

```dotenv
AI_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=https://<your-resource>.openai.azure.com
AZURE_OPENAI_API_KEY=<your-resource-key>
AZURE_OPENAI_DEPLOYMENT=kenyatravel-gpt41mini
```

`AZURE_OPENAI_ENDPOINT` is the HTTPS **resource origin only**, not a full deployment URL. This MVP accepts Azure public resource hostnames under `openai.azure.com`, `cognitiveservices.azure.com` or `services.ai.azure.com`; custom gateways and private-IP endpoints are deliberately not accepted. The API request uses **`/openai/v1/chat/completions`**, the server-only `api-key` header, and the configured **deployment name** as `model`. The supported v1 API requires no dated `api-version` query. See Microsoft's [endpoint switching guide](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/switching-endpoints) and [structured output guide](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs).

The planned KenyaTravel deployment configuration is a dedicated **AIServices S0** account in **East US**, **gpt-4.1-mini version 2025-04-14**, **GlobalStandard** usage-based billing, initially **10 capacity units** (10,000 TPM per the model's published capacity mapping), with the provider's default content filtering and no provisioned throughput, spillover or dynamic-quota expansion. Capacity is a throttle allocation, **not a spending cap**. Monitor model usage and set appropriate subscription budgets/alerts before wider use. GlobalStandard may process requests **outside the resource's East US region**; this is not an East-US-only data-residency guarantee. Resource creation requires an MFA-authenticated Azure CLI session and suitable subscription permissions. As of this integration change, resource creation is **blocked** by Azure's `RequestDisallowedByAzure` MFA enforcement even after a successful interactive CLI login; no dedicated resource or model deployment has been created, and genuine Azure AI calls have not yet been verified. Do not claim a deployment exists until its Azure provisioning state is `Succeeded`.

Use `.env.local` for this local preview only and never commit resource keys or display them in logs/chat. Keep existing Google/payment settings and SQLite data unchanged when editing AI configuration. Restart the app after changing configuration. For production, use a managed identity/Entra access design or managed secret storage with key rotation; this MVP's API-key environment setup is for local activation and is not a production secret-management solution.

The assistant performs a server-side `lookup_catalog` tool call against this agency's curated data, then returns a structured response. **It does not browse the web or query live supplier availability.** Planning preferences, the prompt and (when refining) the current itinerary are sent to the **explicitly selected OpenAI or Azure OpenAI provider**; account details, passwords, quotes and payment information are not. The planner displays that selected provider. Do not type private documents or card data into chat. Review the provider's data policies before enabling it for real travellers.

The server validates dates, duration, sequential days, known destination/activity IDs, duplicate activities and road-transfer feasibility. Transfers over six hours require an activity-free travel day; over ten hours are rejected; five-to-six-hour days allow at most one activity. This is conservative illustrative routing, not live traffic or guaranteed logistics. Costs are **recomputed by the server**, not trusted from the model. The sample USD-to-KES rate is **130**, explicitly not live FX. Over-budget estimates are flagged, not disguised as within budget. The wire schema uses Azure/OpenAI's supported strict JSON subset; full string length, numeric bounds, array limits and business validation remain enforced server-side. Each model request is bounded to 3,500 output tokens, a 60-second timeout, no redirects and no automatic retries/provider fallbacks.

Without AI credentials, the UI visibly says it is not connected. Curated planning, saved trips, manual enquiries and agency quotes remain usable. AI-generated plans are persisted privately and can be refined into a new saved version. AI enquiries are transient conversation state; send an agency enquiry to preserve an actionable conversation.

## Stripe test checkout

Use your own Stripe account's **test keys**; this app does not create a provider account or accept `sk_live_` keys. Configure:

```dotenv
STRIPE_SECRET_KEY=sk_test_<your-test-key>
STRIPE_WEBHOOK_SECRET=whsec_<your-endpoint-secret>
APP_URL=http://localhost:3000
```

For local testing, install the official Stripe CLI separately, sign in to your own test account, and forward events:

```powershell
stripe listen --forward-to http://localhost:3000/api/webhooks/stripe
```

Copy the CLI-provided `whsec_...` secret into `.env.local`, restart the app and keep the CLI listener running. Subscribe deployed endpoints to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired`. A generic `stripe trigger checkout.session.completed` fixture is **not** tied to an app booking and is deliberately rejected; complete a real app-created **test** checkout instead. Use the provider's documented test payment methods, never real card details.

State flow:

```text
saved plan (estimated) → requested → quoted → payment_pending → paid
                                            ↓ expired / async failure
                                          quoted (new checkout version)
```

Amounts/currencies and quote versions are owned by the server. Quotes are immutable while checkout is pending or paid. Checkout creation is provider-idempotent; network failures retain the pending reservation so retrying cannot create an unrelated quote/charge. Session expiry is bounded by the quote expiry and 24 hours. Quotes with less than 31 minutes left cannot initiate a new checkout. Signed webhooks must match the stored checkout ID, version, amount and currency. Event IDs are processed transactionally once. Unpaid checkout completion is not paid; asynchronous success must arrive first. Failure/expiry releases a pending checkout for retry. Closing or cancelling a browser checkout does **not** release it; its provider expiry event does. The webhook listener must remain available for reconciliation.

There is no refund/cancellation automation, deposit/split-payment, tax engine, automatic supplier reservation, email notification or accounting reconciliation. **M-Pesa is not integrated**; provider availability and Kenyan merchant onboarding/settlement must be evaluated separately before production. Stripe test configuration is not a recommendation that this business is eligible for any specific merchant country or payment method.

## Checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm start
```

Domain tests cover itinerary/date/route/estimate validation, plan ownership, quote locks, missing-provider safeguards, signed webhook integrity/idempotency/version binding, amount mismatch rejection and catalog-grounded AI tool use with a mock provider. Google tests verify locally signed RSA tokens (including tampered signature, incorrect issuer/audience/nonce/authorized party, expired/stale tokens and unverified email), PKCE/state expiry/replay, explicit linking, preserved account data and protected agency roles. The HTTP end-to-end check starts a separate production server on port **3017** with a temporary database and non-working Google client fixtures, exercises customer/admin authorization, Google start/cancel/replay/session-binding/logout safeguards, saved plans, requests, quotes, enquiries, catalog edits and unavailable AI/payment integrations, then removes only its own temporary test data. Do not run another server on port 3017 during that check. Tests do not contact Google or make external charges or external AI calls. Genuine Google consent/code exchange, provider checkout and AI responses still require your credentials and separate provider validation.

## Implementation & boundaries

- Next.js App Router, React, TypeScript, Zod, SQLite (`node:sqlite`), JOSE for Google JWT verification, Stripe SDK and Lucide icons. No native SQLite package compilation is required. Node currently labels its SQLite API experimental.
- Scrypt password hashing with random salts, opaque random session cookies stored as SHA-256 hashes, server-side session expiry, HttpOnly/SameSite cookies and same-origin mutation checks. HTTPS `APP_URL` automatically sets Secure cookies. Database-backed action/AI/auth rate limits are conservative single-host limits, not a distributed abuse-prevention service.
- Every private read/action checks the authenticated owner or administrator. The agency only receives saved plans submitted through a booking request; enquiries are explicitly shared with the agency. Prices are never taken from a browser request or model response.
- Curated route IDs, destinations, activity IDs and daily sample rates live in `src\lib\catalog.ts`; seeded package descriptions/visibility live in SQLite. Existing itineraries are immutable snapshots. Editing the seed alone does not overwrite existing database packages.
- Destination photos load from Unsplash and optional web fonts from Google Fonts; offline fallbacks use gradients/system fonts. Illustrative imagery is not a representation of a contracted lodge or supplier. Replace with licensed agency assets and reviewed image descriptions before launch.
- The UI is mobile-responsive with labelled forms, keyboard-focus styles, a focus-trapped dialog and reduced-motion support. Browser history tracks page sections through hashes.

## Production prerequisites

This release is **not production-ready**. Before real traffic or money: confirm business identity and merchant eligibility; replace sample inventory/rates/photos; validate actual transport/return transfers and supplier contracts; establish cancellation/refund and customer support processes; implement email verification and password recovery, MFA for agency accounts, audit logging and operational monitoring; conduct an independent security/privacy/accessibility review; add CSP/nonces and HTTPS/HSTS at the hosting layer; migrate to managed PostgreSQL or an appropriate backed-up durable database; add migrations, backup/restore drills, secrets management, distributed limits and payment reconciliation; implement account/data deletion and reviewed retention/privacy/booking terms; review Kenya and customer-country tourism, consumer, tax and data-protection obligations. Keep passport/health/card data out of this app and its AI.

Running this project does not create a deployment, paid resource, real charge, WhatsApp integration, flight booking or multi-operator marketplace.
