export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
export const RAW_EMAIL_CONTENT_TYPE = "application/vnd.handlefast.email";
export const PROCESSING_LEASE_MS = 5 * 60 * 1000;
export const MAX_PROCESSING_ATTEMPTS = 5;

export function emailExpiresAt(receivedAt: number) {
  const date = new Date(receivedAt);
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}
