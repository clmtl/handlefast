import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
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
  "subscribe and reconcile shipment tracking",
  { minutes: 1 },
  internal.orderTracking.poll,
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
export default crons;
