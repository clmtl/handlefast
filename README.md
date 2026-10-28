# handlefast

## Inbound support email (feature 2)

Implemented on `feature/inbound-email-routing` and deployed to the dedicated staging environment. Real Gmail forwarding, attachment integrity, threading, pause/resume, size limits and outage recovery passed acceptance. Feature 2 is checked in `FEATURES.md`; the integration target is `staging`, before any production promotion.

### Behavior

- Each shop has an individual receiving address under `INBOUND_EMAIL_DOMAIN` (default: `handlefast.io`).
- Maximum **25 MiB (26,214,400 bytes)** for the complete MIME email, including encoded attachments. The limit applies before attachment decoding.
- The Worker reserves an upload through an HMAC-authenticated webhook, uploads the original directly to Convex Storage, and confirms it. The backend verifies its size, SHA-256 and media type before accepting it.
- A scheduled Node action parses the saved original. Node is required because decoding a 25 MiB MIME message exceeds the default Convex runtime's memory limit. Documents contain bounded previews and at most 100 attachment summaries; all content and attachment bytes remain in the original and are available in the reader.
- Interrupted processing is retried up to five times. A five-minute recovery job handles lost execution; administrators can retry failed or paused items. Originals uploaded without a successful confirmation are reconciled after two hours. Only the reserved email media type is eligible for orphan cleanup.
- Email originals, message content and attachment metadata expire **12 calendar months after server receipt**. Scheduled deletion has an hourly catch-up sweep; a failed job can delay physical deletion. Expired originals cannot be requested through the app. Legacy message records are backfilled and expired too.
- Owner/admin users manage reception; organization members can read their shop's emails. Downloads return bearer storage URLs after authorization; treat those URLs as private. The reader shows text, explicit web links and attachment downloads without executing email HTML or fetching remote images.
- Related messages use mail references within the same shop. Unrelated messages start new conversations, and replies reopen closed conversations. Disabled shops/routes reject new arrivals. Pausing does not delete previously received mail.

### Local checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Run an anonymous local backend using a supported Node release (22 or 24). With fnm, for example:

```sh
CONVEX_AGENT_MODE=anonymous fnm exec --using=22 node ./node_modules/convex/bin/main.js dev
```

Keep that process running, then run:

```sh
node scripts/smoke-inbound-email.mjs
```

This local-only test creates synthetic workspaces, stores emails of 1 KiB and exactly 25 MiB through the signed HTTP/upload flow, waits for scheduled parsing, downloads the originals and checks exact byte equality, deduplication and the forwarding challenge. It uses or creates a local webhook secret without printing it. Fixtures remain in the anonymous local database; no email is sent. The storage unit tests compensate for `convex-test` omitting Blob media type metadata; the local test checks the real storage behavior.

### Deployment and manual acceptance

1. Connect a Convex cloud project and authenticate Wrangler. Configure the existing authentication variables plus `INBOUND_EMAIL_DOMAIN` and `CLOUDFLARE_EMAIL_WEBHOOK_SECRET` on Convex. Put the **same** webhook secret on the Worker and set its `CONVEX_SITE_URL` to the cloud HTTP-actions URL. Frontend `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` and `VITE_SITE_URL` must target this deployment, not localhost. See `.env.example`.
2. Deploy Convex before deploying the Worker. The reserve/upload/complete protocol replaces the earlier metadata-only webhook: coordinate rollout while no production email route is enabled.
3. Configure Cloudflare Email Routing and the required MX/TXT records for `handlefast.io`, then route its catch-all to this Worker. Cloudflare only supports catch-all on the apex domain, so do not use `in.handlefast.io` for this setup (see [Cloudflare subdomain configuration](https://developers.cloudflare.com/email-service/configuration/subdomains/)). Preserve MX records on any domain already used by the shop's mailbox. Confirm the effective provider size limit supports the configured 25 MiB maximum.
4. In HandleFast, copy the shop's receiving address. In the existing support mailbox, add it as a forwarding destination and retain a mailbox copy. Gmail's confirmation email can be opened in HandleFast; complete the confirmation and enable forwarding in Gmail.
5. Prepare a test in HandleFast, then send from a different mailbox to the shop's original support address with the displayed subject. The challenge lasts 30 minutes. Only an arriving message whose original To matches that support address marks the connection verified.
6. Validate real text/HTML mail, attachment download, duplicate delivery, separate conversations, replies to closed conversations, disabled reception and recovery after a temporary backend outage. Validate the 25 MiB boundary through Cloudflare as well as Convex. Do not mark feature 2 complete until this real-provider check succeeds.

No automatic reply, spam/SAV classification, Shopify integration or sending pipeline is included in feature 2.

### Staging environment (2026-10-26)

- Site/Worker: https://handlefast-staging.bk201li.workers.dev (`handlefast-staging`).
- Convex: `clement-llorens:handlefast-1a353:preview/staging`, URL `https://frugal-gecko-721.convex.cloud`.
- Email Routing is enabled for `handlefast.io`; its catch-all points to `handlefast-staging`. Cloudflare reports the domain ready. The previous main Worker and Convex production deployment are unchanged.
- Webhook secrets are configured on both services. The deployed backend passed synthetic upload/parsing/download checks at 1 KiB and 25 MiB. These checks do not prove SMTP delivery or forwarding from a real mailbox.
- Resend has verified `handlefast.io`; its sending-only staging key is configured as `RESEND_API_KEY` on this Convex deployment, with `AUTH_EMAIL_FROM=HandleFast <auth@handlefast.io>`. Sending DNS records preserve Cloudflare's inbound routing. Signup deliberately requires email verification.
- Acceptance evidence (2026-10-28): the user received and verified the signup email and signed in. Gmail's forwarding confirmation arrived through Cloudflare and was readable in HandleFast. Forwarding is enabled with a copy retained in Gmail. A real message sent from another mailbox passed the support-address challenge (`Forwarding verified`); its text was readable and its PNG attachment downloaded successfully (2,460,949 bytes, 1496 × 1542 pixels).
- Extended acceptance (2026-10-28): real text/HTML/Unicode and attachment integrity, replies reopening closed conversations, separate unrelated conversations, identical HTTP delivery replay, scheduled processing retry, explicit rejection while paused, and successful reception after resume all passed. A 26,210,470-byte MIME message passed through Gmail/Cloudflare; an oversize message was rejected with SMTP 552. See [the detailed acceptance evidence](docs/inbound-email-acceptance-2026-10-28.md).
- The final pre-storage failure check also passed: after a deliberately failed webhook request, Cloudflare reported a temporary error. Gmail retried the same `Message-ID` about 6 minutes 20 seconds later; the normal Worker stored it and Convex processed it automatically. All fault injection has been removed, and reception is active and verified.

For staging builds, put these public values in the ignored `.env.staging` file:

```dotenv
VITE_CONVEX_URL=https://frugal-gecko-721.convex.cloud
VITE_CONVEX_SITE_URL=https://frugal-gecko-721.convex.site
VITE_SITE_URL=https://handlefast-staging.bk201li.workers.dev
```

Use `npm run deploy:staging` for the Worker. For Convex, the local ignored `.env.deploy-staging` contains a deployment-scoped key: `npx convex deploy --env-file .env.deploy-staging`. Keep deploy keys and backend secrets out of Git. If the staging deployment is replaced, update both URLs and the email route before testing again.

## SAV email filtering (feature 3)

New receipts are classified before creating or reopening a support conversation.
`emailReceipts.triage` stores the current decision; `automaticTriage` preserves the
initial decision and manual corrections record the acting profile and timestamp.
Non-SAV message previews and attachment metadata remain stored, with an optional
`supportMessages.conversationId`; the complete original and 12-month retention
remain available. Existing emails are not reclassified.

- GPT-6 Luna via the Responses API, strict structured outputs, low reasoning,
  no tools or retries. The Convex Agent component runs without a thread, history,
  search or stored generations; OpenAI requests use `store: false`. This flag is
  not a promise of Zero Data Retention at the provider.
- High confidence is required: 0.80 for SAV, 0.95 for exclusions. Scores are model
  estimates, not calibrated probabilities. Uncertainty, empty/attachment-only
  emails, missing credentials, provider failures and budget exhaustion go to review.
  If a long message was truncated, it cannot be automatically excluded.
- Active connection challenges and Gmail forwarding confirmations bypass the AI
  and remain accessible in the reception journal. Customer requests forwarding
  automated notifications are evaluated as requests rather than excluded by headers.
- Owner/admin/agent members can reclassify; viewers can read. Only SAV messages
  belong to conversations. Removing the last SAV message removes its empty
  conversation while preserving the original, preview and attachments.
- Set `OPENAI_API_KEY` on Convex only. `EMAIL_TRIAGE_MONTHLY_BUDGET_USD` defaults
  to 5 across all shops, with UTC calendar-month accounting. Every attempt reserves
  one cent transactionally, even on failure. Input is bounded (24 KB prompt plus
  fixed instructions/schema), output is capped at 1024 tokens, with one request
  and Standard service tier. At the verified 2026-10-28 rates this reservation
  exceeds the maximum request charge, limiting the default to 500 attempts/month.
  This conservative application allowance is not an OpenAI billing account limit;
  unrelated API use is not included. Review pricing before changing the model,
  tier, prompt/token limits or rates. Set the allowance to 0 to disable AI calls.

`npm test` covers classification guards, provider request parameters, fallback,
permissions, manual correction, retention and existing reception behavior.
Run `node scripts/smoke-email-triage.mjs` against an anonymous local backend with
a test OpenAI key to evaluate the synthetic corpus through signed upload, storage
and the scheduled action. It sends no emails and refuses non-local deployments.
The script leaves synthetic fixtures locally and makes billable model requests.
