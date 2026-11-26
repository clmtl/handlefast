import type { EmailPayload } from "./automaticReplyPolicy";
import { shopResendKey } from "./shopSender";

// Both automatic replies and proactive notices freeze their envelope before calling this transport.
export async function deliverEmail(
  payload: EmailPayload,
  idempotencyKey: string,
): Promise<{ id: string } | { retryable: boolean; definite: boolean }> {
  const key = shopResendKey(payload.from);
  if (!key) return { retryable: false, definite: true };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (response.ok) {
      const data = (await response.json()) as { id?: unknown };
      if (typeof data.id !== "string" || !data.id) return { retryable: true, definite: false };
      return { id: data.id };
    }
    const error = (await response.json().catch(() => null)) as { name?: string } | null;
    const concurrent = response.status === 409 && error?.name === "concurrent_idempotent_requests";
    return {
      retryable: response.status >= 500 || response.status === 429 || concurrent,
      definite: response.status < 500 && !concurrent,
    };
  } catch {
    return { retryable: true, definite: false };
  }
}
