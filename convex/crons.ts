import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval(
  "subscribe and refresh new storefront parcels",
  { minutes: 1 },
  internal.orderTracking.refreshStorefront,
  {},
);
crons.interval(
  "expire Shopify browser authorizations",
  { minutes: 5 },
  internal.shopifyGuided.expireDue,
);
crons.interval(
  "recover and synchronize Shopify orders",
  { minutes: 5 },
  internal.shopifySync.recover,
);
crons.interval(
  "expire commerce connections and order cache",
  { hours: 1 },
  internal.commerceMaintenance.expire,
);
crons.interval(
  "recover interrupted email processing",
  { minutes: 5 },
  internal.emailReceipts.recover,
);
crons.interval(
  "reconcile interrupted email uploads",
  { minutes: 5 },
  internal.emailRetention.reconcileUploads,
);
crons.interval("expire emails after twelve months", { hours: 1 }, internal.emailRetention.sweep);
crons.interval(
  "recover automatic support replies",
  { minutes: 1 },
  internal.automaticReplies.recover,
);
crons.interval(
  "monitor delivery promises and recover notifications",
  { minutes: 1 },
  internal.deliveryMonitoring.recover,
);
crons.interval(
  "classify historical support emails",
  { minutes: 1 },
  internal.emailClassification.backfill,
);
export default crons;
