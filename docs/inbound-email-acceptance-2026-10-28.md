# Feature 2: staging acceptance, 2026-10-28

Environment: `handlefast-staging.bk201li.workers.dev`, Convex `preview/staging`
(`frugal-gecko-721`). Synthetic run: `HF-QA-1793209218660`.

The mailbox owner authorized test sends from `auth@handlefast.io` to the configured
Gmail support mailbox. Gmail kept its own copies and automatically forwarded to
the shop's HandleFast address. Production was not modified.

## Observed results

| Scenario | Evidence | Result |
| --- | --- | --- |
| Text, HTML, Unicode and attachment | Real Resend → Gmail → Cloudflare → Convex delivery; original text and HTML retain accented characters. The 51-byte attachment has SHA-256 `afffc02c8196cb104d909ee7362d20e06f8d0b81a3b64a3a1499f123b06902b4`. | Passed |
| Reply to a closed conversation | A staging-only fixture closed the synthetic baseline conversation. A real reply with its received `Message-ID` in `In-Reply-To` and `References` reused that conversation and reopened it. | Passed |
| Independent message with same sender and subject | A new real email without reply references created a different conversation. | Passed |
| Large attachment | An 18,874,368-byte binary attachment produced a 25,840,157-byte received MIME email. Cloudflare recorded a successful invocation (48 ms CPU); Convex processed it on attempt 1. | Passed |
| Attachment integrity and browser download | The original downloaded from storage and the attachment downloaded using the dashboard both match the sent file: SHA-256 `2399268a21ad634b0d0fdcdce5b571ae451d8798add968a69f47f5d1336bcce5`. | Passed |
| Near-boundary delivery | A 19,145,000-byte binary attachment produced a 26,210,470-byte MIME email, only 3,930 bytes below the configured maximum. Convex processed it on attempt 1; the downloaded attachment matches the sent SHA-256 `f672ce2c5abb5096eaac9cffea939751c944d3d05a7ab1a1c7594c75464a0ca3`. | Passed |
| Oversize rejection | A 19,922,944-byte attachment exceeds 25 MiB after MIME encoding. Gmail received `552 5.3.4 Email data size exceeded` from the forwarding destination. No receipt was created. | Passed |
| Identical delivery replay | Replayed the real baseline's envelope, size and SHA-256 through the signed reserve endpoint. It returned the existing receipt with `accepted`; the three-message count stayed at three. This is an HTTP replay, not a second SMTP transaction. | Passed |
| Failure after storage | A small synthetic original was uploaded and a narrow internal fixture set its processing lease. Calling the real failure handler left it saved and failed. The scheduled retry processed it automatically on attempt 2, about two minutes later, without a manual retry. | Passed |
| Reception paused | Paused in the dashboard, then sent a real email. Gmail received `555 5.7.1 This HandleFast address is not accepting email`. No new receipt/message was created; previous mail stayed readable. | Passed |
| Reception resumed | Resumed in the dashboard and prepared a fresh challenge. A real email to the support mailbox changed the status back to `Forwarding verified`. | Passed |
| Backend request failure before storage | A temporary Worker condition applied an invalid webhook signature only to the uniquely named synthetic email. The real HTTP request returned 401, and the Worker threw. Cloudflare reported `upstream (worker:handlefast-staging) temporary error: worker script threw an exception`. Normal configuration was restored immediately afterward. Gmail retried the same `Message-ID` about 6 minutes 20 seconds later; Cloudflare recorded a successful invocation and Convex processed its 12,107-byte original on attempt 1. | Passed |

## Scope and limitations

- Two large repetitive text fixtures were classified as spam by Gmail and were
  not forwarded. A binary fixture passed. This is a mailbox behavior, not a
  HandleFast receipt failure; the setup UI now explains it. No spam bypass rule
  was installed. See [Google's forwarding behavior](https://support.google.com/mail/answer/10957).
- The configured maximum is 26,214,400 bytes for the **complete encoded email**,
  not for decoded attachment bytes. Actual SMTP headers vary by provider. The
  exact byte boundary is covered by local/deployed backend checks; the provider
  checks use messages below and above that limit. See [Cloudflare's inbound limit](https://developers.cloudflare.com/email-service/platform/limits/#email-routing-limits).
- The retry-after-storage fixture tests the real scheduler and parser without
  causing a global backend outage. It is distinct from the Worker/SMTP test.
- Twelve-calendar-month expiry is covered by automated tests and the scheduled
  retention code; this acceptance run does not claim to observe a year of time.
- All temporary fixture functions and the single-message Worker fault injection
  were removed and the normal backend/Worker redeployed after their tests.
- The complete suite passed again: 59 automated tests. This run also passed
  TypeScript, Biome lint and a staging production build after the setup-copy fix.

All acceptance scenarios above passed. The feature is ready for review into `staging`; this is not a production-release approval.
