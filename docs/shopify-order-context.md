# Shopify order context and 17TRACK (feature 4)

Implementation is deployed to staging for acceptance. Live merchant installation and real carrier acceptance are still required before checking feature 4 complete.

## Staging deployment — 2026-10-28

- Application code: `706cf0431e95c8d050456ebb735d1c7d8383fc0f` (PR #5, pending merge into `staging`).
- Frontend/Worker: `handlefast-staging`, `https://handlefast-staging.bk201li.workers.dev`, deployed version `dccac09f-d7f2-4eb9-bdba-985a78288ddc`.
- Convex: `clement-llorens:handlefast-1a353:preview/staging`, `https://frugal-gecko-721.convex.cloud`; HTTP endpoints use `https://frugal-gecko-721.convex.site`.
- `COMMERCE_ENCRYPTION_KEY` generated, configured and read back for equality without logging its value. A backup is stored outside Git in the main checkout's ignored `.env.commerce-staging`, mode `0600`. Preserve this key for this deployment.
- Verified the served connector matches the source byte for byte, the pairing endpoints reject unauthenticated requests, and the signed-in owner dashboard shows the enabled Shopify connection form.
- `TRACK17_API_KEY` is not configured yet. The tracking webhook returns `503 TrackingNotConfigured` until it is supplied; no merchant store or real tracking number has been connected by these deployment checks.

## Client connection

1. An owner/admin enters the shop's permanent `*.myshopify.com` domain in HandleFast.
2. HandleFast issues a random, single-use pairing code valid for 30 minutes. The server binds it to the existing shop, organization and initiating profile. Neither the command nor its completion payload accepts an organization ID.
3. The client downloads `/handlefast-shopify-connect.mjs` from the HandleFast site and runs the displayed command using Node.js 22.12 or later. There is no unpublished npm package to install.
4. The connector runs the pinned official `@shopify/cli@5.0.0`: `app init --template none`, config validation, `app deploy`, and `app info`. Shopify authenticates the client and asks which Shopify organization to use when several are available. It must be the organization that owns the store. The connector creates a new app and configures **only `read_orders`** and signed order/fulfillment/refund/uninstall webhooks. It never submits an App Store listing.
5. The connector reads the selected Shopify organization from CLI output and opens Shopify's installation page. The merchant must approve installation on the intended store. It then captures the app's client ID/secret from CLI output without printing them and sends them over HTTPS to the pairing endpoint.
6. HandleFast exchanges the credentials, verifies the canonical Shopify domain and order-data access, rechecks current management membership, and consumes the pairing atomically. It stores the client secret and short-lived access token using AES-256-GCM with the HandleFast shop ID as additional authenticated data. Tokens renew server-side before expiry. A Shopify domain and app client ID cannot be claimed by another HandleFast shop.

The merchant authenticates and approves installation; this flow does not automate Shopify consent. App creation is in the **client's Shopify organization**, so the organization-only client credentials grant is applicable. No central HandleFast app or public distribution is used.

Kopy's public landing page was inspected and its application was opened. Its connection screens require sign-in, so this implementation does not claim to have reproduced private Kopy screens or undocumented internals.

References: [Shopify CLI app init](https://shopify.dev/docs/api/shopify-cli/app/app-init), [app info](https://shopify.dev/docs/api/shopify-cli/app/app-info), [client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).

## Configuration needed

- **HandleFast operator:** a persistent, random 32-byte key encoded as base64 in the backend-only `COMMERCE_ENCRYPTION_KEY`. For new environments, generate it with `openssl rand -base64 32` and set it via `convex env set COMMERCE_ENCRYPTION_KEY` using stdin. Keep a secure backup; replacing the key makes existing connection credentials unreadable and requires reconnection. Never use a `VITE_` prefix. Local testing and staging already have separate keys; preserve them.
- **Shopify test merchant:** the permanent `myshopify.com` domain, a Shopify account with permission to create apps in the store's organization and install them, and a few orders including a refund and multiple parcels. The merchant runs the connector. No Shopify password or client secret needs to be pasted into chat. Access beyond the default 60-day order history needs Shopify's additional `read_all_orders` approval/configuration; the first version requests only `read_orders`. [Orders permissions](https://shopify.dev/docs/api/usage/access-scopes#orders-permissions)
- **17TRACK:** an API account, an API key with registration quota set as backend-only `TRACK17_API_KEY`, and a webhook configured at `https://<convex-http-host>/webhooks/17track`. For the existing staging environment that URL is `https://frugal-gecko-721.convex.site/webhooks/17track`. Configure it only when these backend routes are deployed. Use an account separate from production for acceptance. [17TRACK documentation](https://api.17track.net/en/doc)
- **Frontend/deployment:** `VITE_CONVEX_SITE_URL` must target the same HTTP-actions deployment as the frontend's `VITE_CONVEX_URL`. `SITE_URL` must be the public HandleFast site, which serves the connector as a static asset. Deploy backend before frontend. No application has been installed on a real merchant store by this change.

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
npm run test:shopify-connect
npm run build
```

Start an anonymous local backend with Node 22/24 and set its required auth variables and local encryption key, then run `npm run smoke:commerce`. It refuses cloud deployments, creates synthetic local auth/workspace fixtures, exercises real HTTP pairing and cancellation, and makes no Shopify or 17TRACK requests.

The connector test runs the full subprocess flow against a fake Shopify CLI and a localhost pairing server. Provider/backend tests cover real request shapes with mocked responses, encryption binding, tenant isolation, pairing expiry/replay/revocation, matching, manual correction, multiple parcels, viewer permissions, signed tracking updates, stale jobs and failure recovery. GraphQL operations validate against Shopify's `2026-10` schema. The actual React panels were visually checked with synthetic order/carrier data; that preview is not evidence of live provider access.

Before acceptance: run the connector with a real test merchant; confirm app ownership, minimal scopes, install approval, access to customer/order fields, automatic organization binding and token renewal; receive Shopify notifications; register real numbers with 17TRACK and verify signature, delivery changes, quota exhaustion, temporary outage and recovery. Confirm cross-shop isolation with a second shop and uninstall/purge behavior. Only then check feature 4 in `FEATURES.md`.
