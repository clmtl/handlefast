# Shopify order context and 17TRACK (feature 4)

Feature 4 is deployed and accepted on staging. Merchant installation, automatic organization binding, order import, SAV association and manual correction, live Shopify token renewal and a real 17TRACK push all passed. The final acceptance consumed **zero additional 17TRACK credits**. Production promotion is separate.

## Final acceptance — 2026-10-29

113 automated tests, TypeScript and Biome pass. The frontend staging build was already verified; final acceptance adds backend/operator checks without changing that frontend.

The whole-project `npm run check` additionally reports a pre-existing import-order issue in `src/server.test.ts`, unchanged from `staging`. `npm run lint`, TypeScript and the focused Biome check for the added acceptance files pass.

| Scenario | Result |
| --- | --- |
| SAV email → order → parcels | Two marked synthetic MIME messages were ingested through the real signed inbound HTTP upload and parsing/triage pipeline. The matching sender and explicit reference selected cached order #2057 automatically; the reader displayed its actual items and delivered parcel history. This does not claim another SMTP forwarding test. |
| Different sender | The same reference from the synthetic alternate sender selected no order automatically. A manual association displayed the identity warning. |
| Manual correction | Staff changed the selection from #2057 to #2059 in the live UI; the saved link recorded the acting profile. Removal and restoration of automatic association were verified for both messages. |
| Shopify renewal | The staging-only internal helper forced the existing expired-token branch without first invalidating the stored token. Shopify issued a new token valid for approximately 24 hours; encrypted persistence and access to the expected shop were verified. No overnight expiry wait was needed. |
| Real 17TRACK notification | One `/push` request targeted an already registered delivered parcel after fallback polling had settled. Its stored synchronization time advanced and 24 provider history events were present. No new number, retrack or carrier change was requested. |
| Tracking quota | `getquota`: 200 total, **39 used / 161 remaining both before and after**. Delta: **0**. The 39 previously used credits belong to the initial import. |
| Cleanup | Both marked receipts, messages and associated test records were removed through normal retention. The live inbox and database confirmed their removal. Imported merchant orders and parcels were preserved. |

`convex/commerceAcceptance.ts` exposes only internal functions and refuses any `SITE_URL` other than this staging host. Fixture cleanup requires the exact run header and subject prefix and accepts at most three receipts; a mixed customer/test batch is rejected atomically. Regression tests verify those guards and preserve a working stored token on renewal failure.

The operator runner `scripts/accept-commerce-staging.mjs` accepts `--step prepare|resume|renew|manual|check|push|quota|cleanup`, explicit `--deploy-env` and `--track-env` paths, and an optional `--manifest`. Credentials and the private run manifest stay outside Git. `prepare` selects only cached orders whose parcels (including other orders for the same sender) are already registered; `resume` continues the same fixtures after interruption. Complete the UI correction before `manual`, restore associations before `check`, then request `push` at most once, measure `quota`, and always `cleanup`. The runner permits only `getquota` and `push` directly and rejects a nonzero quota delta. Avoid rerunning initial import against new fixtures to test UI behavior.

## Current staging deployment — 2026-10-29

- Browser connection code: `c8fe7c7`, with corrections through `991f1ff` (PR #5 into `staging`). Convex, including the final internal acceptance helpers, deployed successfully to `frugal-gecko-721`; the existing encryption key was verified against its preserved backup and was not changed.
- Worker `handlefast-staging`, `https://handlefast-staging.bk201li.workers.dev`, version `11165c9c-75a4-4b74-bc1d-37821aa7a980`. The customer enters a store link and approves Shopify's browser prompts; there is no downloadable connector or terminal command.
- Cloudflare's `assets-upload-session` endpoint returned HTTP 500 / error `10013` with Wrangler 4.105.0 and 4.155.0. For this staging deployment only, public build files are packaged as Worker modules by `node scripts/staging-assets-fallback.mjs` and deployed using `dist/server/wrangler.staging-fallback.json`. This keeps the same URL and backend configuration. A future normal staging deployment can restore the standard static-assets service.
- All 14 deployed public assets match the staging build byte for byte. Dashboard and callback routes return HTML; the old connector file and pairing HTTP routes return 404. The merchant completed browser authorization and installation; the dashboard shows the connected shop. The fallback was also checked locally for content types, conditional GET, HEAD and method handling.

### Staging correction after merchant authorization — 2026-10-29

- The merchant's CLI authorization and automatic organization lookup succeeded. Shopify rejected app creation (`SHOPIFY_APP_CREATE_REJECTED`); the generated branding name was 31 characters, exceeding Shopify CLI's 30-character branding schema limit.
- Generated names are now capped at 30 characters and validated before the provider request. Retrying a confirmed rejection replaces an invalid legacy name in the existing operation. Ambiguous attempts retain their original names so recovery cannot create a duplicate app. The provider test now enforces Shopify's actual limit; 108 tests, TypeScript and lint pass.
- Backend correction `bde3040` is deployed to `frugal-gecko-721`. The frontend Worker version is unchanged. A fresh browser authorization was prepared for the merchant to retry.
- `TRACK17_API_KEY` is configured on staging and was read back for equality without logging its value. The authenticated `v2.4/getquota` check succeeded: 200 total, 200 remaining, 0 used. The ignored local `.env.17track-staging` file is mode `0600`.
- The deployed webhook accepts a correctly signed empty update (HTTP 200) and rejects an invalid signature (HTTP 401). The account's Package Webhook is saved as `https://frugal-gecko-721.convex.site/webhooks/17track`, version 2.4, with all nine parcel statuses enabled; these settings were verified after a full reload. The official 17TRACK test displayed `Operación completada`. No tracking number was registered by those configuration checks; the subsequent real push is covered by final acceptance above.
- Merchant retry successfully created the dedicated Shopify app. The browser's Shopify admin used a different account from the CLI, so installation initially showed `Unauthorized Access`. Switching to the same account as the CLI restored store access and the native installation screen, which awaits merchant approval. No further app was created and installation was not approved by the agent.
- Installation now goes through Shopify's account selector (`/login?returnPath=...`) before the store-specific OAuth request, so multiple signed-in accounts cannot silently select an account without store access. The relative return path preserves the exact store, client ID, read-only scope, callback and unpredictable state. The account selector and return to the native grant screen were verified in the live browser; all 108 tests pass with the nested callback state.
- Backend correction `991f1ff` is deployed to staging. The merchant completed the new flow and Shopify returned successfully through the signed callback. The original app was reused; its connection is active with only `read_orders`, the HandleFast shop/organization binding matches, and support webhook registration completed.
- The initial import completed without error: 42 orders and 39 parcels. An early tracking snapshot already contained 22 registrations and 16 real histories (including delivered, in-transit and information-received states); remaining parcels continue through the bounded tracking queue or display provider unavailability. The official webhook test is verified separately; real histories alone do not establish whether an update arrived through push or polling.

## Historical first staging deployment — 2026-10-28 (superseded)

- Application code: `706cf0431e95c8d050456ebb735d1c7d8383fc0f` (PR #5, pending merge into `staging`).
- Frontend/Worker: `handlefast-staging`, `https://handlefast-staging.bk201li.workers.dev`, deployed version `dccac09f-d7f2-4eb9-bdba-985a78288ddc`.
- Convex: `clement-llorens:handlefast-1a353:preview/staging`, `https://frugal-gecko-721.convex.cloud`; HTTP endpoints use `https://frugal-gecko-721.convex.site`.
- `COMMERCE_ENCRYPTION_KEY` generated, configured and read back for equality without logging its value. A backup is stored outside Git in the main checkout's ignored `.env.commerce-staging`, mode `0600`. Preserve this key for this deployment.
- Verified the served connector matches the source byte for byte, the pairing endpoints reject unauthenticated requests, and the signed-in owner dashboard shows the enabled Shopify connection form.
- `TRACK17_API_KEY` is not configured yet. The tracking webhook returns `503 TrackingNotConfigured` until it is supplied; no merchant store or real tracking number has been connected by these deployment checks.

## Client connection — browser only (2026-10-29)

1. An owner/admin enters the Shopify admin link, permanent `*.myshopify.com` domain or store handle and clicks **Connecter ma boutique**.
2. HandleFast starts the device-authorization flow used by Shopify CLI. Shopify opens in a new tab and displays the confirmation code. If popups are blocked, the same authorization page is available through a button. The merchant approves **Shopify CLI**, then returns to HandleFast.
3. The backend exchanges the device approval, resolves the exact store through Shopify's destinations API and automatically obtains its owning Shopify organization. It verifies app-development access there; no organization is selected or guessed in the browser.
4. The backend creates a dedicated merchant-owned HandleFast app using the same App Management API as Shopify CLI. The app requests **only `read_orders`**. The device-session management tokens are encrypted, temporary and never returned to the frontend.
5. HandleFast opens Shopify's account selector; the merchant selects the same account used for CLI approval and reaches the store's native installation page. After approval, Shopify returns to `/auth/shopify/callback`. The backend verifies the complete signed query, unpredictable state, age, exact shop, initiating profile and current management role before exchanging the code and binding the connection atomically to its original HandleFast organization/shop.
6. The client secret and order token are encrypted using the existing commerce key and tenant binding. Device/management credentials are removed on handoff; app credentials in the temporary session are removed when connection succeeds. Temporary sessions expire and are swept; durable app-creation checkpoints retain only app identifiers and operation metadata so retries cannot silently create duplicate apps after a timeout.
7. Order webhooks are registered server-side after installation (`orders/create`, `orders/updated`, `orders/cancelled`, `orders/fulfilled`, `orders/partially_fulfilled`, `refunds/create`, `app/uninstalled`). Registration reads existing subscriptions first and retries with the initial sync if needed. These topics are compatible with the app's read-only order scope.

This adapts the implementation in the user's Shopifast project. The CLI identity/App Management adapter remains isolated because Shopify's App Management API is explicitly `unstable`; it is not a supported public Admin API surface and can change. No Shopify CLI executable runs on the customer's machine. The former downloadable script and pairing HTTP routes have been removed. Legacy pairing records are retained only for automatic expiration.

References: [Shopify CLI destinations lookup](https://github.com/Shopify/cli/blob/1cf6e579fd5812dd2ee9922813ec6bd78363f3e9/packages/store/src/cli/utilities/store-lookup/destinations.ts), [standalone app OAuth](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps), [client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).

## Configuration needed

- **HandleFast operator:** a persistent, random 32-byte key encoded as base64 in the backend-only `COMMERCE_ENCRYPTION_KEY`. For new environments, generate it with `openssl rand -base64 32` and set it via `convex env set COMMERCE_ENCRYPTION_KEY` using stdin. Keep a secure backup; replacing the key makes existing connection credentials unreadable and requires reconnection. Never use a `VITE_` prefix. Local testing and staging already have separate keys; preserve them.
- **Shopify test merchant:** the permanent `myshopify.com` domain, a Shopify account with permission to create apps in the store's organization and install them, and a few orders including a refund and multiple parcels. The merchant approves the two Shopify browser prompts; no download, terminal or manual app setup is required. No Shopify password or client secret needs to be pasted into chat. Access beyond the default 60-day order history needs Shopify's additional `read_all_orders` approval/configuration; the first version requests only `read_orders`. [Orders permissions](https://shopify.dev/docs/api/usage/access-scopes#orders-permissions)
- **17TRACK:** an API account, an API key with registration quota set as backend-only `TRACK17_API_KEY`, and a webhook configured at `https://<convex-http-host>/webhooks/17track`. For the existing staging environment that URL is `https://frugal-gecko-721.convex.site/webhooks/17track`. Configure it only when these backend routes are deployed. Use an account separate from production for acceptance. [17TRACK documentation](https://api.17track.net/en/doc)
- **Frontend/deployment:** `VITE_CONVEX_SITE_URL` must target the same HTTP-actions deployment as the frontend's `VITE_CONVEX_URL`. `SITE_URL` must be the public HandleFast site, which serves the browser callback route. Deploy backend before frontend. The staging merchant installation has now completed successfully.

## Behavior and limits

- The initial import requests orders updated in the last 60 days. Later imports resume from the last completed synchronization with a five-minute overlap. Signed Shopify webhooks trigger an import; a five-minute recovery sweep handles lost jobs. Healthy connections are eligible again after 15 minutes and are picked up by the next five-minute sweep. API pages are bounded, leased, idempotent and protected against stale writes after reconnect/disconnect. Throttled pages retry with their current cursor rather than starting over immediately.
- Email context is shown only for an unexpired SAV receipt. Automatic selection requires both the sender's normalized email and one explicit, matching order reference. Missing or ambiguous matches remain unselected. Staff can search by order number, manually associate a same-shop order, suppress automatic association, or restore it. Manual choices retain the acting profile and timestamp. A different sender email is visibly flagged. Viewers can read, but cannot search, change associations, or trigger API calls.
- Orders show financial and fulfillment states, cancellation, current total, refunded amount, item variants/SKUs and destination city/postcode/country. Each cached order includes up to 50 items, 10 fulfillments and 10 tracking numbers per fulfillment. Larger orders display an explicit partial-preview notice and a link to Shopify. Snapshots are not represented as a complete audit log or full order export.
- Each parcel has its own tracking record and up to 50 normalized events (10 shown in the reader). 17TRACK receives the tracking number and an opaque internal tag; additional carrier-specific identification requirements are not guessed. Unsupported/ambiguous numbers remain unavailable and retry. Carrier names from Shopify are retained for display; numeric 17TRACK carrier codes come from provider responses.
- Tracking subscriptions and fallback reads run from a minute-based, bounded queue; nonterminal parcels are rechecked every six hours if webhooks are lost. A reader refresh queues its parcels for an earlier check. Delivered/returned parcels stop frequent reconciliation. Webhooks verify SHA-256 of the original body plus `/` plus the 17TRACK API key. Older dated updates cannot replace newer history. Missing data, registration quota errors and provider failures are shown as unavailable; no delivery estimate is invented.
- Disconnect/uninstall immediately removes usable credentials, invalidates pending generations and asynchronously deletes the cached orders, parcels and associations. Clients must uninstall the app inside Shopify to revoke Shopify's authorization as well. Disabling a HandleFast shop prevents provider reads. Order snapshots expire after 365 days from placement; links also disappear when their emails expire. Data requests/redaction webhooks are not part of this merchant-owned private-app configuration; full public-app distribution/compliance is outside this feature.

## Validation

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Start an anonymous local backend with Node 22/24, required auth variables and an isolated commerce key, then run `npm run smoke:commerce`. This creates synthetic local auth/workspace fixtures and verifies authenticated session binding, public-state redaction and cancellation. The optional `node scripts/smoke-commerce.mjs --live-device` additionally issues and cancels a real Shopify device authorization; it never approves the code, creates an app, or contacts 17TRACK.

Tests cover the browser-only sequence with mocked provider responses, automatic Shopify organization resolution, approval polling and slow-down handling, callback signature/state/replay guards, current role checks, duplicate-tab leases and recovery after an ambiguous app-create response. Existing tests still cover order matching, corrections, parcels, retention, signed events and provider failures. Shopify order/webhook operations validate against the Admin API 2026-10 schema; App Management operations follow the isolated Shopify CLI adapter rather than pretending to validate against the public Admin schema.

Verified on staging: real device approval and installation, automatic organization binding, read-only scopes, order access and webhook registration, SAV association and manual correction, live token renewal, 17TRACK configuration, real histories and one subsequent provider push. Feature 4 is checked in `FEATURES.md`; the final acceptance used no additional tracking credit. This validation does not authorize or perform a production release.
