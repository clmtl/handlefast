import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
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
