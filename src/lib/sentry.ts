import * as Sentry from "@sentry/react";

export function initClientSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;

  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    sendDefaultPii: false,
    tracesSampleRate: getClientTraceSampleRate(),
  });
}

function getClientTraceSampleRate() {
  const configuredRate = Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE);

  if (Number.isFinite(configuredRate) && configuredRate >= 0 && configuredRate <= 1) {
    return configuredRate;
  }

  return import.meta.env.PROD ? 0.1 : 1.0;
}
