# Proactive delivery notifications (feature 8, V1)

The dashboard's **Surveillance des retards** checks cached orders against a shop's promised maximum delivery timeframe, including preparation. Configuration starts in **simulation**, without automatic initialization of a merchant's actual delivery promise. Owners/admins choose 1–90 calendar/business days, an IANA timezone, a daily local hour, a notification language (French/English/Spanish), and up to 80 explicit closed/holiday dates. Business days are Monday–Friday; no national holiday calendar is silently assumed.

## Deadlines, simulation and activation

A deadline is the end of the final promised local calendar day, counting from the day after the order. Business-day calculations skip weekends and the configured dates. Daily scheduling calculates the next local run, including DST changes; a minute dispatcher processes due shops and batches of ten orders. The scan reads Shopify/17TRACK caches and never calls either provider.

Policy versions have effective timestamps. A promise is recorded per stable shop/Shopify order GID and retains its original deadline when settings change or the cached order is replaced. Orders preceding the first known rules can be simulated using current settings, clearly marked as indicative. They cannot be emailed retrospectively.

Real sending requires a completed simulation of the same configuration within 24 hours, active Shopify/reception and configured email service. Activation starts a new scope containing only orders placed after activation; switching off and on starts a new scope. Saving settings and **Simuler maintenant** always perform a simulation, even when the daily automatic mode is live. Changing rules requires another simulation before live activation. Simulation never queues a new notification or calls Resend.

**À surveiller** lists candidates and blocked cases; **Historique** includes orders previously detected overdue, exclusions and accepted sends. The interface shows deadlines/timezones, why an order is blocked, indicative promises, message previews and sending status. Agents can cancel queued/retrying sends; only owners/admins manage rules. Viewer and tenant boundaries are enforced on the server.

## Eligibility and contact matching

- An eligible order must have a valid customer email, confirmed payment, an active matching connection generation and a successful complete Shopify sync within 24 hours. An unchanged order can rely on a fresh incremental connection sync; its own source timestamp need not change daily.
- Cancelled/fully refunded/completely delivered orders are excluded. Partial refunds, unknown fulfillment states, truncated data, absent tracking for fulfilled orders, return/exception states and incomplete tracking require verification. Nonterminal parcel snapshots older than 12 hours block sending. All parcels are considered, so one delivered parcel does not close a partially delivered order.
- Contact checking is scoped to the shop, sender and order date. A manual order link, a proactive conversation's order identity or explicit order reference can establish contact. An email about another known order does not suppress this order; missing/unverifiable references are conservative blockers. Existing unresolved intake pauses sending because a forwarded envelope may not identify the original customer until parsing.
- Dispatch rechecks configuration revision, live activation scope, expiry, connection/reception, latest cached order/parcel facts and customer contact. A changed context invalidates the queued message. Once the HTTP request has started, cancellation cannot recall the mail.

## Sending, replies and retention

The feature shares the tested Resend transport with feature 7. Notifications use reviewed fixed templates with no fabricated ETA, reason for delay or promise of an action. This V1 needs no LLM call for detection or message generation. All existing AI classification and human assistance remain exclusively on **GPT-6 Luna**.

One notice record per shop/Shopify order identity prevents repeated daily sends and survives reconnection/cache deletion. Payload/recipient and idempotency key are frozen for retries; at most three provider attempts occur within two hours of queueing. Unknown acceptance remains uncertain, including after a later definitive rejection. The recovery job handles interrupted leases without changing the payload or retry key. Accepted/failed/uncertain notices cannot restart from a later scan. An explicit staff cancellation remains effective across scans.

The customer's per-notice Reply-To alias remains valid until the order's one-year retention deadline, while reception is active. A reply from the intended recipient rejoins the existing conversation, enters SAV by a server rule, identifies the correct same-email cached order and creates a human task. It cannot trigger an immediate feature-7 automatic reply. Another sender cannot inherit the conversation or order context. Expiry removes notices/aliases and any empty notification conversation.

Provider acceptance is distinct from mailbox delivery; the UI does not claim a delivery/bounce webhook or guarantee inbox placement.

## Staging acceptance — 29 October 2026

Acceptance uses an isolated QA shop, three explicitly synthetic cached orders, a non-refreshing fixture connection and zero shipments. It never imports real customer orders or registers a tracking number.

- Browser: save the default seven-business-day simulation, view candidates/blocking reasons and enable real sending after simulation.
- Simulation: three overdue orders; one eligible candidate, one refunded exclusion and one missing-tracking blocker. Zero send attempts or outgoing payloads.
- Live fixture: activation timestamps are backdated only by a temporary staging fixture to exercise the overdue branch immediately. Exactly one notification is accepted by Resend for the verified owner's HandleFast email; the other orders have zero attempts. Re-running its send action twice is a no-op.
- Real Gmail reception confirms correct body, recipient, Reply-To, SPF and DKIM. **Gmail placed this proactive test in Spam.** Inbox placement is not validated; the source domain currently has no published DMARC TXT record. No causal claim is made about the filtering decision, and no DNS/security settings were changed by this feature.

- A real Gmail reply to the per-notice alias returned to the correct HandleFast conversation, selected its cached order and created a human task. Classification and human proposal metadata both confirm GPT-6 Luna. No feature-7 automatic reply was created. Browser checks verified the human alert and history.

**218 automated tests pass**, including 37 feature-8 tests and all feature-7 transport regressions. Coverage includes DST gaps/offsets, business days/holidays, invalid settings, default simulation/no network calls, activation freshness/scope, immutable promises, cancelled/refunded/delivered/partial deliveries, stale/missing data, order-specific/ambiguous contacts, unparsed intake, final dispatch checks, stable-ID deduplication after cache replacement, fixed retry payloads/keys, retry limits/unknown outcomes, pagination beyond the first batch, cancellation/roles/tenant boundaries, reply aliases and retention. TypeScript, Biome lint/check and the staging build pass.

The 17TRACK account moved from 41 used / 159 remaining to 42 used / 158 remaining during acceptance. The newest registered shipment was created by the normal Shopify synchronization on the existing merchant shop (outside the QA shop, after this worktree was created). No test parcel was registered; the fixture has zero shipments. The test itself makes no tracking API calls. The QA shop, fake connection/orders, policy versions, notices, raw reply and conversation are cleaned up before the final backend deploy, and the temporary fixture functions are removed from source. Existing merchant shops remain unconfigured for feature 8; no advertised delivery timeframe is guessed or enabled on their behalf.

Staging backend: `https://frugal-gecko-721.convex.cloud` (`preview/staging`). Frontend: `https://handlefast-staging.bk201li.workers.dev`. Production promotion is separate.

Final frontend deployment: `e2b69111-4c0f-4726-93bb-d7b3c3855b1e`; all 13 public assets match the staging build byte for byte.
