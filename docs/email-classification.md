# SAV categories and importance (feature 5)

Each newly processed SAV email receives one primary category and an importance based on its content. The category and importance appear in the SAV inbox and email reader. Indexed category/importance filters are applied before pagination; they can be combined and reset.

Categories: order status, delivery issue, damaged/defective item, wrong/missing item, return/exchange, refund, cancellation/change, payment issue, warranty and other SAV. Importance is independent of category:

| Importance | Interpretation |
| --- | --- |
| Low | Acknowledgement, thanks or resolved issue without further action. |
| Normal | Routine request without explicit urgency. |
| High | Significant delay, blocked use, repeated unresolved complaint or near deadline. |
| Urgent | Explicit safety risk, suspected payment fraud or imminent irreversible deadline. |

The model selects a bounded reason code, translated into a fixed French explanation by the application. Uppercase subjects or the word “urgent” alone are insufficient for urgent importance. No order facts or delivery estimates are inferred from Shopify/17TRACK: this feature classifies the email content and uses only bounded, same-shop/same-sender reply context. It makes **no commerce or parcel API requests**.

## Processing and corrections

- Classification runs in a separate scheduled action after ingestion commits, so provider failure cannot lose or delay receipt of an email. Moving an email into SAV queues analysis too; moving it out invalidates an in-flight result.
- A transactional request token prevents concurrent requests and duplicate execution from duplicating the model call. An abandoned job expires after two minutes into an explicit review fallback and can be relaunched by staff. Stale completions cannot replace newer requests.
- GPT-6 Luna uses the existing backend-only `OPENAI_API_KEY`, strict structured output, low reasoning, a 1,024-token output limit, 30-second timeout and no SDK retries. No new secret or package is required. The Convex Agent has no thread/history/search/tools, saves no messages and requests `store: false`. This setting does not promise provider Zero Data Retention.
- Input is limited to a 500-character subject, 5,000-character body and 1,500-character reply context, with an additional 24,000-byte request guard. Empty/attachment-only mail, missing keys, provider errors, uncertainty or truncated input require review. Attachments are not inspected.
- Model confidence is an estimate, not a calibrated probability. Below 0.80, category becomes “other” and review is required. A suggested high/urgent signal remains visible while awaiting human verification; an uncertain low suggestion is raised to normal.
- Owners, admins and agents can change category/importance or relaunch an automatic analysis. Viewers can read. Every API checks shop membership; the actor and correction timestamp are derived server-side. A manual decision wins any later automatic response. The first automatic result is retained separately, including an initial fallback if one occurred.
- Existing emails remain “Non classé” until staff choose **Analyser cet email** or classify them manually. There is no automatic historical backfill. Classified data expires with its receipt under the existing 12-month retention.

## Verification — 2026-10-29

124 automated tests pass, including classification guards, structured provider request/no retries, missing credentials/errors, empty content, request deduplication, abandoned jobs, late completions, manual corrections, role/tenant boundaries, bounded reply context and indexed filters before pagination. TypeScript, Biome lint and the staging build pass.

Five marked synthetic MIME emails were uploaded through the real signed staging HTTP upload, parsing, SAV triage and scheduled classification pipeline. No email was sent through SMTP. All five were reanalysed against the final normalized-reason implementation:

| Synthetic request | Category | Importance |
| --- | --- | --- |
| English routine status question | Order status | Normal |
| French three-week delay with repeated unanswered requests | Delivery issue | High |
| Spanish refund request | Refund | Normal |
| French suspected active payment fraud | Payment issue | Urgent |
| French resolved issue with no further request | Other SAV | Low |

The live browser verified combined payment/urgent filters, filter reset, legacy “Non classé” display and the email reader. Staff changed the marked refund email to return/exchange with high importance; saved values, acting profile and preserved automatic refund decision were checked through the authenticated API. All five marked receipts and originals were removed through normal retention afterward. The temporary staging-only cleanup helper was removed before final deployment.

17TRACK `getquota` remained **200 total / 39 used / 161 remaining** before and after acceptance. **0 additional credits, 0 test parcels.** No initial import, registration, retrack, carrier change, push or parcel refresh was requested.

Staging backend: `https://frugal-gecko-721.convex.cloud` (`preview/staging`). Frontend: `https://handlefast-staging.bk201li.workers.dev`. Cloudflare again rejected normal static asset upload with error 10013; the existing `scripts/staging-assets-fallback.mjs` packaging was used. The deployed public assets were compared byte for byte with the final build.
