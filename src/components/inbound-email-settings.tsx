import { useAction, useMutation, useQuery } from "convex/react";
import PostalMime, { type Email } from "postal-mime";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { OrderContext } from "./order-context";

const button =
  "rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";

export function InboundEmailSettings({ shopId }: { shopId: Id<"shops"> }) {
  const connection = useQuery(api.emailInbox.connection, { shopId });
  const receipts = useQuery(api.emailInbox.recent, { shopId });
  const beginTest = useMutation(api.emailInbox.beginTest);
  const setEnabled = useMutation(api.emailInbox.setEnabled);
  const retry = useMutation(api.emailInbox.retry);
  const provision = useMutation(api.inboundEmailRoutes.ensureForShop);
  const [supportEmail, setSupportEmail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Id<"emailReceipts"> | null>(null);

  async function perform(task: () => Promise<unknown>, success = "") {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await task();
      setNotice(success);
    } catch {
      setError(
        "The action could not be completed. Check the address and connection, then try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!connection) return <p className="p-5 text-sm">Loading email connection…</p>;
  const currentEmail = supportEmail ?? connection.supportEmail;
  const testExpired = connection.testExpiresAt !== null && connection.testExpiresAt < Date.now();
  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Connect your support inbox</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Up to 25 MiB per complete email, including encoded attachments. Originals are
              automatically deleted after 12 months.
            </p>
          </div>
          <span className="rounded-full border px-3 py-1 text-sm font-medium">
            {connection.verified
              ? "Forwarding verified"
              : !connection.enabled && connection.address
                ? "Reception paused"
                : "Setup incomplete"}
          </span>
        </div>
        {error && (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="mt-4 text-sm" role="status">
            {notice}
          </p>
        )}
        {!connection.address ? (
          <div className="mt-5">
            <p className="mb-3 text-sm">Create a receiving address for this shop.</p>
            {connection.canManage && (
              <button
                className={button}
                disabled={busy || connection.shopDisabled}
                type="button"
                onClick={() => void perform(() => provision({ shopId }))}
              >
                Create address
              </button>
            )}
          </div>
        ) : (
          <ol className="mt-6 space-y-6">
            <li>
              <h2 className="font-medium">1. Copy your HandleFast address</h2>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="break-all rounded-md border bg-background px-3 py-2 text-sm">
                  {connection.address}
                </code>
                <button
                  className={button}
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void perform(
                      () => navigator.clipboard.writeText(connection.address ?? ""),
                      "Address copied.",
                    )
                  }
                >
                  Copy address
                </button>
              </div>
            </li>
            <li>
              <h2 className="font-medium">2. Enable forwarding in your existing mailbox</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                In Gmail: Settings → See all settings → Forwarding and POP/IMAP → Add a forwarding
                address. Enter the address above. Keep a copy in your existing inbox. Open the
                confirmation email below and follow its verification link, then enable forwarding in
                Gmail. Gmail does not forward spam: check its Spam folder if a test email does not
                arrive.
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                For Outlook or another provider, use its forwarding settings. If forwarding is
                restricted, your mailbox administrator must enable it.
              </p>
              <a
                className="mt-2 inline-block text-sm text-primary underline"
                href="https://support.google.com/mail/answer/10957"
                target="_blank"
                rel="noreferrer"
              >
                Gmail forwarding instructions
              </a>
            </li>
            <li>
              <h2 className="font-medium">3. Verify that forwarding works</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Enter your shop’s existing support address, then prepare a test. From another
                mailbox, send an email to your support address with the exact subject shown below.
              </p>
              {connection.canManage ? (
                <form
                  className="mt-3 flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform(
                      () => beginTest({ shopId, supportEmail: currentEmail }),
                      "Test prepared. Send the email with the subject below.",
                    );
                  }}
                >
                  <label className="sr-only" htmlFor="support-email">
                    Shop support email
                  </label>
                  <input
                    id="support-email"
                    type="email"
                    required
                    maxLength={320}
                    className="h-10 min-w-64 rounded-md border bg-background px-3 text-sm"
                    placeholder="support@your-shop.com"
                    value={currentEmail}
                    onChange={(event) => setSupportEmail(event.target.value)}
                  />
                  <button className={button} type="submit" disabled={busy || !connection.enabled}>
                    Prepare test
                  </button>
                </form>
              ) : (
                <p className="mt-2 text-sm">Ask a workspace administrator to prepare the test.</p>
              )}
              {connection.testSubject && !connection.verified && (
                <div className="mt-3 rounded-md border p-3 text-sm">
                  <p>
                    Send to: <strong>{connection.supportEmail}</strong>
                  </p>
                  <p className="mt-1 break-all">
                    Subject: <code>{connection.testSubject}</code>
                  </p>
                  <p className="mt-2 text-muted-foreground">
                    {testExpired
                      ? "This test has expired. Prepare a new test."
                      : "The test expires after 30 minutes. This page updates when it arrives."}
                  </p>
                  <button
                    className={`${button} mt-2`}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () => navigator.clipboard.writeText(connection.testSubject ?? ""),
                        "Test subject copied.",
                      )
                    }
                  >
                    Copy subject
                  </button>
                </div>
              )}
              {connection.verified && (
                <p className="mt-3 font-medium text-primary" role="status">
                  A test email reached this shop through its support address.
                </p>
              )}
            </li>
          </ol>
        )}
        {connection.lastReceivedAt && (
          <p className="mt-5 text-sm text-muted-foreground">
            Last email received: {new Date(connection.lastReceivedAt).toLocaleString()}
          </p>
        )}
        {connection.canManage && connection.address && (
          <button
            className={`${button} mt-5`}
            type="button"
            disabled={busy || connection.shopDisabled}
            onClick={() => void perform(() => setEnabled({ shopId, enabled: !connection.enabled }))}
          >
            {connection.enabled ? "Pause reception" : "Resume reception"}
          </button>
        )}
        {connection.shopDisabled && (
          <p className="mt-3 text-sm">This shop is disabled. Email reception is stopped.</p>
        )}
      </section>
      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-lg font-semibold">Recently received emails</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The latest 25 emails, including forwarding confirmations. Open an email to read it or
          download its attachments.
        </p>
        {!receipts ? (
          <p className="mt-4 text-sm">Loading…</p>
        ) : receipts.length === 0 ? (
          <p className="mt-5 text-sm">
            No emails received yet. Configure forwarding, then send a test.
          </p>
        ) : (
          <ul className="mt-4 divide-y">
            {receipts.map((receipt) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 py-4"
                key={receipt.id}
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">{receipt.subject}</p>
                  <p className="mt-1 break-all text-sm text-muted-foreground">
                    {receipt.from} · {new Date(receipt.receivedAt).toLocaleString()}
                  </p>
                  <p className="mt-1 text-sm">
                    {receipt.status === "processed"
                      ? "Received"
                      : receipt.status === "failed"
                        ? "Original saved — processing failed"
                        : receipt.status === "paused"
                          ? "Original saved — reception paused"
                          : receipt.status === "uploading"
                            ? "Upload incomplete"
                            : "Original saved — processing"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    className={button}
                    type="button"
                    disabled={!receipt.hasOriginal}
                    onClick={() => setSelected(receipt.id)}
                  >
                    Open email
                  </button>
                  {connection.canManage &&
                    (receipt.status === "failed" || receipt.status === "paused") && (
                      <button
                        className={button}
                        type="button"
                        disabled={busy || !connection.enabled}
                        onClick={() =>
                          void perform(
                            () => retry({ receiptId: receipt.id }),
                            "Processing restarted.",
                          )
                        }
                      >
                        Retry
                      </button>
                    )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {selected && (
        <EmailReader key={selected} receiptId={selected} close={() => setSelected(null)} />
      )}
    </div>
  );
}

export function EmailReader({
  receiptId,
  close,
}: {
  receiptId: Id<"emailReceipts">;
  close: () => void;
}) {
  const download = useAction(api.emailInbox.download);
  const [content, setContent] = useState<{
    email: Email;
    raw: ArrayBuffer;
    attachmentIds: string[];
  } | null>(null);
  const [error, setError] = useState("");
  const [rawFile, setRawFile] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function load() {
      try {
        const url = await download({ receiptId });
        if (cancelled) return;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const raw = await response.arrayBuffer();
        if (!cancelled) setRawFile(raw);
        const email = await PostalMime.parse(raw, {
          attachmentEncoding: "arraybuffer",
          maxHeadersSize: 128 * 1024,
          maxNestingDepth: 32,
        });
        if (!cancelled)
          setContent({
            email,
            raw,
            attachmentIds: email.attachments.map(() => crypto.randomUUID()),
          });
      } catch {
        if (!cancelled)
          setError(
            "This email could not be opened. It may have expired. Close this panel and try again.",
          );
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [download, receiptId]);
  const email = content?.email;
  const links = email
    ? [
        ...new Set(
          Array.from(
            (email.html ?? "").matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi),
            (match) => match[1].replaceAll("&amp;", "&"),
          ),
        ),
      ].slice(0, 30)
    : [];
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <section className="min-w-0 rounded-lg border bg-card p-5" aria-label="Email content">
        <div className="flex items-center justify-between gap-3">
          <h2 className="break-words text-lg font-semibold">
            {email?.subject ?? "Opening email…"}
          </h2>
          <button className={button} type="button" onClick={close}>
            Close
          </button>
        </div>
        {error && (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {rawFile && !content && (
          <button
            className={`${button} mt-3`}
            type="button"
            onClick={() => saveFile(new Blob([rawFile], { type: "message/rfc822" }), "email.eml")}
          >
            Download original email
          </button>
        )}
        {content && email && (
          <>
            <p className="mt-2 break-all text-sm text-muted-foreground">
              From: {email.from?.address}
            </p>
            <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-4 font-sans text-sm leading-6">
              {email.text ?? email.html?.replace(/<[^>]*>/g, " ") ?? "No text content."}
            </pre>
            {links.length > 0 && (
              <div className="mt-4">
                <h3 className="font-medium">Links in this email</h3>
                <ul className="mt-2 space-y-2">
                  {links.map((link) => (
                    <li key={link}>
                      <a
                        className="break-all text-sm text-primary underline"
                        href={link}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {link}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                className={button}
                type="button"
                onClick={() =>
                  saveFile(new Blob([content.raw], { type: "message/rfc822" }), "email.eml")
                }
              >
                Download original email
              </button>
              {email.attachments.map((attachment, index) => (
                <button
                  className={button}
                  type="button"
                  key={content.attachmentIds[index]}
                  onClick={() =>
                    saveFile(
                      new Blob(
                        [
                          attachment.content instanceof Uint8Array
                            ? new Uint8Array(attachment.content).buffer
                            : attachment.content,
                        ],
                        { type: "application/octet-stream" },
                      ),
                      attachment.filename ?? `attachment-${index + 1}`,
                    )
                  }
                >
                  Download {attachment.filename ?? `attachment ${index + 1}`}
                </button>
              ))}
            </div>
          </>
        )}
      </section>
      <OrderContext receiptId={receiptId} />
    </div>
  );
}

function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = Array.from(filename, (char) =>
    char.charCodeAt(0) < 32 || char === "/" || char === "\\" ? "_" : char,
  ).join("");
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
