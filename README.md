# handlefast

## Inbound support email (feature 2)

Implemented on `feature/inbound-email-routing`. Real Cloudflare delivery and mailbox forwarding still need deployment and acceptance testing; `FEATURES.md` remains unchecked until then.

### Behavior

- Each shop has an individual receiving address under `INBOUND_EMAIL_DOMAIN`.
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
3. Configure Cloudflare Email Routing and the required MX/TXT records for the receiving domain, then route its catch-all to this Worker. Preserve MX records on any domain already used by the shop's mailbox. Confirm the effective provider size limit supports the configured 25 MiB maximum.
4. In HandleFast, copy the shop's receiving address. In the existing support mailbox, add it as a forwarding destination and retain a mailbox copy. Gmail's confirmation email can be opened in HandleFast; complete the confirmation and enable forwarding in Gmail.
5. Prepare a test in HandleFast, then send from a different mailbox to the shop's original support address with the displayed subject. The challenge lasts 30 minutes. Only an arriving message whose original To matches that support address marks the connection verified.
6. Validate real text/HTML mail, attachment download, duplicate delivery, separate conversations, replies to closed conversations, disabled reception and recovery after a temporary backend outage. Validate the 25 MiB boundary through Cloudflare as well as Convex. Do not mark feature 2 complete until this real-provider check succeeds.

No automatic reply, spam/SAV classification, Shopify integration or sending pipeline is included in feature 2.
