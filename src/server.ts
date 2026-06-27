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
    tracesSampleRate: 1.0,
  }),
  workerHandler,
);
