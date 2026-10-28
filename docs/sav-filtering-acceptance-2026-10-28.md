# SAV email filtering acceptance — 2026-10-28

Branch: `codex/sav-email-filtering`, based on staging `73cddfe`.
Model: `gpt-6-luna`, Responses API, structured output, low reasoning.

## Automated checks

- 76 tests pass, including the 62 existing tests. Added coverage for exclusion
  guards, SDK request parameters, no unbudgeted retries, missing credentials,
  provider failure, budget exhaustion, role/shop authorization, manual
  corrections, preserved originals/attachments and non-SAV retention.
- TypeScript, Biome lint, staging frontend/server build and Convex deployment pass.
- 16 synthetic examples passed through the actual signed reserve/upload/complete
  webhook, stored originals, scheduled parsing and real Luna requests on both
  the anonymous local deployment and the staging backend.

| Cases | Expected | Result |
| --- | --- | --- |
| Late delivery (French), wrong item/refund (English), return (Spanish), warranty (German), missing order number, customer forwarding an automated notification, injected instructions alongside an actual damaged order | SAV | 7/7 |
| Pre-purchase question, newsletter, marketing pitch, automated order confirmation, wholesale vendor catalog | Hors SAV | 5/5 |
| Vague request, empty email, thanks without context, long advertising prefix hiding a support request beyond the excerpt | À vérifier | 4/4 |

This small synthetic corpus is a regression check, not a measured production
accuracy rate. Actual customer traffic still needs monitoring.

## Staging UI

Worker version: `0b4c5a29-48cb-4b01-9f51-e0e4e3ee2605`.
Backend: `frugal-gecko-721` (preview/staging).
The existing authenticated session opened the dashboard successfully. Three
clearly marked `HF-QA filtre SAV` synthetic messages were uploaded to the test
shop through the signed protocol. No email was sent.

- Damaged order, advertising and vague request appeared in SAV, Hors SAV and
  À vérifier respectively, with readable reasons.
- Opening the damaged-order original displayed its sender, subject and full text.
- Moving that message to Hors SAV removed it from SAV, preserved its content and
  showed the manual-correction reason. Moving it back restored it to SAV.
- The previous forwarding connection remained verified, and historical emails
  and Gmail's confirmation remained accessible in the reception journal.

The three HF-QA messages remain in the test shop. The separate synthetic smoke
workspace also remains in staging, isolated by membership. Existing emails were
not reclassified. The OpenAI key is configured on the staging backend only and
was never committed or exposed to the browser. The application allowance is
5 USD/month across all shops, conservatively reserving one cent per request.

## Scope

This feature filters after-sales requests. It does not yet assign detailed
categories, urgency, draft replies or send replies (features 5–7). Questions
explicitly about a future purchase are outside SAV. Uncertain requests remain
available for human review. No Shopify lookup is required to retain a request.

Official model and pricing references checked on 2026-10-28:
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/pricing
