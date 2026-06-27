import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";

const workerHandler = {
  fetch(request: Request) {
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: getServerTraceSampleRate(env),
  }),
  workerHandler,
);

function getServerTraceSampleRate(env: Env) {
  const configuredRate = Number(env.SENTRY_TRACES_SAMPLE_RATE);

  if (Number.isFinite(configuredRate) && configuredRate >= 0 && configuredRate <= 1) {
    return configuredRate;
  }

  return 0.1;
}
