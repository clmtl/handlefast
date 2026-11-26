import { maxTakeoutMessageBytes } from "./takeout-mbox";

export const gmailReadScope = "https://www.googleapis.com/auth/gmail.readonly";
const apiRoot = "https://gmail.googleapis.com/gmail/v1/users/me/";

type GmailToken = { access_token?: string; error?: string; scope?: string };
type GmailOAuth = {
  initTokenClient: (options: {
    client_id: string;
    scope: string;
    include_granted_scopes: boolean;
    callback: (token: GmailToken) => void;
    error_callback: () => void;
  }) => { requestAccessToken: (options: { prompt: string }) => void };
};
type GmailWindow = Window & { google?: { accounts?: { oauth2?: GmailOAuth } } };
type GmailMessage = {
  id: string;
  internalDate?: string;
  labelIds?: string[];
  sizeEstimate?: number;
};
export type GmailImportCounts = { imported: number; duplicate: number; skipped: number };

let sdk: Promise<GmailOAuth> | undefined;
export function loadGoogleAuthorization() {
  if (!sdk) {
    sdk = new Promise<GmailOAuth>((resolve, reject) => {
      const oauth = (window as GmailWindow).google?.accounts?.oauth2;
      if (oauth) return resolve(oauth);
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = () => {
        const client = (window as GmailWindow).google?.accounts?.oauth2;
        if (client) resolve(client);
        else reject(new Error("GoogleUnavailable"));
      };
      script.onerror = () => reject(new Error("GoogleUnavailable"));
      document.head.appendChild(script);
    }).catch((error: unknown) => {
      sdk = undefined;
      throw error;
    });
  }
  return sdk;
}

async function gmailGet<T>(path: string, token: string, signal: AbortSignal) {
  const response = await fetch(new URL(path, apiRoot), {
    headers: { Authorization: `Bearer ${token}` },
    signal,
    referrerPolicy: "no-referrer",
    redirect: "error",
  });
  if (response.status === 401) throw new Error("GmailExpired");
  if (!response.ok) throw new Error("GmailUnavailable");
  return (await response.json()) as T;
}

export async function importGmailHistory({
  token,
  address,
  shopId,
  signal,
  report,
}: {
  token: string;
  address: string;
  shopId: string;
  signal: AbortSignal;
  report: (counts: GmailImportCounts) => void;
}) {
  const result: GmailImportCounts = { imported: 0, duplicate: 0, skipped: 0 };
  const safeAddress = address.replace(/[\\"]/g, "\\$&");
  const params = new URLSearchParams({
    q: `newer_than:1y {to:"${safeAddress}" cc:"${safeAddress}" from:"${safeAddress}"} -in:drafts -in:spam -in:trash`,
    maxResults: "100",
  });
  do {
    const page = await gmailGet<{ threads?: { id: string }[]; nextPageToken?: string }>(
      `threads?${params}`,
      token,
      signal,
    );
    for (const thread of page.threads ?? []) {
      const { messages = [] } = await gmailGet<{ messages?: GmailMessage[] }>(
        `threads/${encodeURIComponent(thread.id)}?format=metadata&fields=messages(id,internalDate,labelIds,sizeEstimate)`,
        token,
        signal,
      );
      messages.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
      for (const message of messages) {
        if (
          (message.sizeEstimate ?? 0) > maxTakeoutMessageBytes ||
          message.labelIds?.some((label) => ["DRAFT", "SPAM", "TRASH"].includes(label))
        ) {
          result.skipped++;
        } else {
          const { raw } = await gmailGet<{ raw?: string }>(
            `messages/${encodeURIComponent(message.id)}?format=raw&fields=raw`,
            token,
            signal,
          );
          if (!raw || raw.length > Math.ceil(maxTakeoutMessageBytes / 3) * 4) {
            result.skipped++;
          } else {
            const bytes = Uint8Array.from(
              atob(raw.replace(/-/g, "+").replace(/_/g, "/")),
              (character) => character.charCodeAt(0),
            );
            const upload = await fetch(
              `/api/takeout?${new URLSearchParams({
                shop: shopId,
                date: message.internalDate ?? "",
                source: "gmail",
                thread: thread.id,
              })}`,
              {
                method: "POST",
                headers: { "Content-Type": "message/rfc822" },
                body: bytes,
                signal,
              },
            );
            if (!upload.ok) throw new Error("ImportUnavailable");
            const reply = (await upload.json()) as { result?: string };
            if (
              reply.result !== "imported" &&
              reply.result !== "duplicate" &&
              reply.result !== "skipped"
            )
              throw new Error("ImportUnavailable");
            result[reply.result]++;
          }
        }
        report({ ...result });
      }
    }
    if (!page.nextPageToken) break;
    params.set("pageToken", page.nextPageToken);
  } while (!signal.aborted);
  return result;
}
