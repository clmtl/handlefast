# Automatic support replies (feature 7)

Owners and administrators configure **Réponses automatiques** in the dashboard. Each shop has an enable switch and an explicit matrix of ten categories × four importance levels. Agents/viewers can read the rules; only owners/admins can change them. Automation is disabled by default with no rules. Existing merchant settings were not enabled during acceptance.

Rules apply only to newly received SAV emails after activation. Historical emails and manual moves into SAV cannot trigger retrospective sends. Saving a changed policy increments its revision: pending work from the previous revision cannot send. The reader displays the response text, recipient, time and sending status; staff can cancel pending work and take over.

## Response scope

- Every planner request uses `gpt-6-luna`, through the existing Convex Agent and Responses API, with strict structured output, low reasoning, 1,024 output tokens, a 30-second timeout and zero SDK retries. No tools/history/search or Agent message storage; `store: false`.
- The planner selects only an intent, language and confidence. The server renders reviewed French/English/Spanish templates rather than sending arbitrary model-written text. Unsupported languages or confidence below 0.95 require human handling. Classification must itself be AI-generated, confident (at least 0.90), complete and free of a review flag.
- Supported responses communicate known shipping/preparation status, ask for a missing order reference/email, request missing item/problem details, or acknowledge an explicitly resolved issue. Refunds, replacements, cancellations and other commercial decisions are never executed by this pipeline. An authorization rule does not override these limits.
- Tracking replies require a same-sender identified order, a cache snapshot less than 24 hours old and usable active parcel statuses. Stale/incomplete tracking, identity mismatch, unknown statuses, cancellations, truncation, unread attachments, contradictory or action-required requests fall back to the human queue. No ETA or policy is invented. A missing order can produce a request for a reference only when the customer has not already supplied one.
- The shared order-reference parser excludes ordinary prose such as “commande” followed by “Bonjour”; explicit `#` references, numeric references and uppercase identifiers remain supported.

## Dispatch and conversation guarantees

The transactional outbox has one record per receipt. Claims and lease tokens prevent concurrent workers from generating/sending the same reply. The latest inbound message, unexpired receipt, active shop/reception route, policy revision, recipient, classification, human takeover and cached context are checked again before sending. A conversation reserves a 30-minute cooldown when its automatic reply is queued; later messages within it stay available for human handling.

Automatic/bulk/list messages, bounce/no-reply senders, mismatched Reply-To recipients, invalid message IDs and replies from the support address are excluded. Anti-loop headers are evaluated before the stored forty-header limit. Outgoing mail carries `Auto-Submitted: auto-replied`, `X-Auto-Response-Suppress: All`, threading references and an automatic-reply marker.

Resend receives a frozen body/envelope and a stable `Idempotency-Key` per outbox record. Network/concurrency/rate-limit retries reuse both. There are at most three send attempts within two hours of receipt; retries never extend beyond this deadline, exceed the provider's 24-hour idempotency window, or bypass a policy/context change. The minute recovery cron handles interrupted workers. An unresolved acceptance outcome is labelled uncertain, even when a later attempt produces a definitive error; staff are told to check the mailbox before replying.

Resend rewrites Message-ID, as verified with real Gmail delivery. Each outgoing reply therefore uses a random per-response `hf_reply_…@handlefast.io` Reply-To address, resolved by the existing catch-all intake. It rejoins the conversation only for the original recipient, active reception and an unexpired parent receipt, even when the client omits References. Standard In-Reply-To/References still group the initial reply in Gmail. These aliases need no additional DNS/routing configuration on the existing domain.

“Acceptée par le service d’envoi” means API acceptance, not guaranteed inbox delivery. No delivery/bounce webhook is claimed. Once the provider request has started, a rule change cannot recall it. The UI prevents cancellation of an active request or an accepted send. Expiration deletes the outbox together with the original receipt and disables its reply alias.

## Validation — 29 October 2026

**181 tests pass**, covering existing email/commerce functionality plus rule authorization and tenant boundaries, new-versus-historical receipt eligibility, confidence/category checks, loop headers beyond forty, template coherence, fresh/stale/wrong-identity cached orders, changed context/newer messages, cancellation and late completion, fixed payload/idempotency, definitive and ambiguous provider failures, bounded recovery, alias validation/threading/cooldown, retention and the exact GPT-6 Luna request contract. TypeScript, Biome lint/check and the staging build pass.

Real acceptance used an isolated manual QA shop with no commerce connection and only the owner's verified HandleFast/Gmail address:

1. Gmail → Cloudflare intake → triage/classification/planner with GPT-6 Luna → Resend → Gmail Inbox. The reference request arrived in the original Gmail thread with SPF/DKIM passing, correct recipient and anti-loop/thread headers. One provider attempt was recorded.
2. A real Gmail reply to the per-response alias returned to the same HandleFast conversation and created no second automatic send during cooldown.
3. A real cancellation/refund request created an open human alert with summary/proposal; no send was attempted, despite all category/importance combinations being enabled in the isolated QA shop.
4. Browser checks verified the matrix, saved a changed rule and disabled automation, then a new real Gmail SAV email created a human alert with no outbox send.
5. Re-running the accepted send action twice was a no-op: its attempt count and provider ID stayed unchanged. The final QA run had four inbound messages, one accepted automatic reply and three human alerts. An earlier reference-reply run also verified delivery and exposed the provider Message-ID rewrite before the alias fix.

No Shopify or 17TRACK operation was used by acceptance; **zero test parcels were registered**. The 17TRACK account stayed at 41 used / 159 remaining before and after acceptance (zero additional credits). QA receipts, raw storage, outbox, conversations and the temporary shop/route were removed; the temporary fixture function was removed before the final backend deployment.

Staging backend: `https://frugal-gecko-721.convex.cloud` (`preview/staging`). Frontend: `https://handlefast-staging.bk201li.workers.dev`. Production was not promoted.
