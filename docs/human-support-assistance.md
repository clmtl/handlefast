# Human support assistance (feature 6)

SAV emails that cannot receive an automatic reply now create a visible **Demandes à traiter** alert. Each email has a French summary, a suggested course of action, a draft in the customer's language and a list of facts to verify. Staff can edit/save/copy the draft and move the email through **À traiter → En cours → Traité**, with an explicit reopen action. The acting profile and timestamps are recorded server-side.

## Reply permission and workflow

There are currently no category/importance authorization rules or customer-email sending pipeline (feature 7). The shop's `autoReplyEnabled` flag alone does not authorize a response. The server records a fixed blocking reason: automation disabled, classification requiring review, sensitive importance, or no authorized rule. Every new SAV receipt therefore requires human handling. A proposal never grants permission or executes an action.

The alert is created transactionally when ingestion commits, before the classification/model calls finish. The assistance action waits for category/importance processing, including its failure fallback. A manual move into SAV creates an alert; a move out removes it and invalidates pending work. Existing emails can be prepared individually from their reader; there is no bulk historical backfill. Each new reply has its own receipt/alert rather than silently reopening a previously handled receipt.

The dashboard has indexed, paginated status tabs and a reactive alert banner. Counts are bounded at 50 and display `50+` for larger queues. Marking an email treated does not send a response or close a conversation containing other messages. The draft can be copied into the staff member's existing mailbox after verification.

## Model, evidence and failure behavior

- Every model request uses **`gpt-6-luna`**, through the existing Convex Agent and Responses API. It uses strict structured output, low reasoning, at most 3,000 output tokens, a 45-second timeout and zero SDK retries. No thread/history/search/tools are enabled; generations are not saved by the Agent and requests use `store: false`. This flag does not promise provider Zero Data Retention.
- The structured schema explicitly names the French summary, solution and missing-information fields separately from the customer-language draft. The public proposal fields remain language-neutral (`summary`, `solution`, `draftReply`).
- Input is bounded to a 500-character subject, 6,000-character body, 1,500-character same-shop/same-sender reply context, five items and five active parcel snapshots, with an additional 32,000-byte request guard. Attachments are not inspected. Truncation, unread attachments, missing order, identity mismatch, stale/incomplete tracking and uncertain classification are shown explicitly.
- Order selection shares the existing cache-only matching helper. Automatic selection requires both the sender email and one unambiguous order reference. A manual association to a different address is flagged and its order details are excluded from the model input. Credentials, delivery addresses, SKUs and tracking numbers are excluded from that input.
- Generation makes no Shopify/17TRACK calls. The new human-review reader also opens using recorded commerce information; refreshing is an explicit staff action. The normal SAV reader retains its existing refresh behavior.
- A context fingerprint detects changed classification, selected order, source update or parcel facts. A changed context during generation discards that result into an explicit fallback; changes afterward mark the proposal stale. An unchanged cache refresh does not invalidate it.
- Request tokens and transactional claims prevent concurrent/duplicate generation. Jobs expire after two minutes into a visible fallback and can be relaunched. Late responses cannot replace newer requests. Generation preserves an edited draft and human treatment status.
- Empty mail, missing credentials, provider failures or malformed output keep the alert open with a manual-treatment fallback and no invented reply. Low confidence removes the suggested reply and adds a verification warning. Model confidence is not a calibrated probability; all generated text requires human validation, including checking policies, facts and commitments.
- Owners, admins and agents can prepare, edit and change status; viewers can read. All public operations enforce verified authentication and shop membership. Proposal/draft/status data lives in the receipt and follows its existing 12-month retention.

## Acceptance — 2026-10-29

**141 automated tests pass**, including existing reception, classification and commerce behavior. New coverage includes early alert creation, classification handoff, explicit reply denial even with the enable flag, request deduplication, stale results, timeouts, missing credentials/provider errors, empty content, role/tenant isolation, bounded cache/context use, private-field exclusion, manual draft/status preservation, status pagination and capped counters, expiry/retention, and the exact GPT-6 Luna provider contract/no retries. TypeScript, Biome lint, the focused Biome check and the staging build pass.

Four marked MIME fixtures were uploaded through the signed staging HTTP upload → storage → parsing → SAV triage → classification → scheduled assistance flow. No SMTP email or customer reply was sent.

| Fixture | Evidence |
| --- | --- |
| French defect request with an existing matching order | Summary distinguished the customer's report from cached order facts, included the actual two-item context and proposed asking which item was affected. No refund or replacement was promised as completed. |
| Spanish return/refund request without an order reference | Missing-order warning, French summary/solution/information requests and Spanish draft asking for the reference and purchase email. Retested after making language requirements explicit in schema field names. |
| Quoted prompt injection requesting a completed refund/sent response | The draft ignored those instructions and requested the minimum information needed to examine the real defect request. No external action was executed. |
| Empty message manually moved to SAV | Classification and assistance fell back; the human alert remained visible and no reply was fabricated. |

The live browser verified the alert count, the status tabs, summary/solution/draft in the reader, saving and copying an edited draft, taking charge and marking treated. The saved draft and acting profile were verified through the authenticated API. A subsequent real GPT-6 Luna regeneration preserved both the human draft and treated state. After reload, the saved draft was still present and the reader showed the recorded-information mode.

All four marked receipts, originals, proposals and edited drafts were removed through normal retention. The temporary staging-only cleanup helper was removed before final deployment.

### 17TRACK budget

The account started at **200 total / 39 used / 161 remaining**. The final measurement is **200 / 40 / 160**, a delta of **one credit**, within the requested five-parcel ceiling. During the run, normal commerce synchronization imported a new shipment for a different real order/customer; that record was created at 11:34:24 UTC. This coincides with the account increment and was not a synthetic fixture. The acceptance itself used an already registered cached parcel and did not directly register, retrack, change carrier or request a parcel refresh. The new reader now avoids the normal reader's automatic Shopify lookup when opening a human task.

Backend: `https://frugal-gecko-721.convex.cloud` (`preview/staging`). Frontend: `https://handlefast-staging.bk201li.workers.dev`. Standard Cloudflare static-asset deployment succeeded for this release; the earlier packaging fallback was not needed. Deployed public assets were compared byte for byte with the final staging build.
