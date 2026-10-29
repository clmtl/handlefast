import { type Infer, v } from "convex/values";
import { emailPayload } from "./automaticReplyPolicy";

export const deliveryMode = v.union(v.literal("off"), v.literal("simulation"), v.literal("live"));
export const deliveryCalendar = v.union(v.literal("calendar"), v.literal("business"));
export const deliveryLocale = v.union(v.literal("fr"), v.literal("en"), v.literal("es"));
export const promiseFields = {
  maxDays: v.number(),
  calendar: deliveryCalendar,
  timezone: v.string(),
  holidays: v.array(v.string()),
};
export const deliveryConfig = { ...promiseFields, hour: v.number(), locale: deliveryLocale };
export type DeliveryConfig = Infer<typeof configValidator>;
export const configValidator = v.object(deliveryConfig);
export const policyFields = {
  shopId: v.id("shops"),
  ...deliveryConfig,
  mode: deliveryMode,
  revision: v.number(),
  versionId: v.id("deliveryPolicyVersions"),
  liveFrom: v.optional(v.number()),
  nextRunAt: v.number(),
  updatedAt: v.number(),
  updatedBy: v.id("profiles"),
  scanToken: v.optional(v.string()),
  scanStartedAt: v.optional(v.number()),
  lastScanAt: v.optional(v.number()),
  lastSimulationAt: v.optional(v.number()),
  simulatedVersionId: v.optional(v.id("deliveryPolicyVersions")),
};
export const versionFields = { shopId: v.id("shops"), ...deliveryConfig, effectiveAt: v.number() };
export const deliveryReasons = {
  not_due: "Délai non dépassé",
  eligible: "Notification possible",
  disabled: "Surveillance désactivée",
  historical: "Commande antérieure à l’activation réelle",
  cancelled: "Commande annulée",
  refunded: "Commande remboursée",
  unpaid: "Paiement ou remboursement à vérifier",
  delivered: "Livraison complète confirmée",
  tracking_issue: "Suivi incomplet ou anomalie à vérifier",
  stale: "Synchronisation ou suivi trop ancien",
  disconnected: "Connexion Shopify indisponible",
  reception: "Réception SAV indisponible",
  recipient: "Adresse du client absente ou invalide",
  contacted: "Client déjà en contact pour cette commande",
  ambiguous_contact: "Contact client sans commande identifiable",
  pending_email: "Email entrant encore à traiter",
  policy_changed: "Configuration modifiée",
  context_changed: "Informations de commande modifiées",
  expired: "Envoi expiré",
  provider_rejected: "Service d’envoi en échec",
  delivery_unknown: "Envoi incertain : vérifier avant de répondre",
  provider_retry: "Nouvelle vérification de l’envoi prévue",
  human_takeover: "Envoi annulé par l’équipe",
} as const;
export const deliveryReason = v.union(
  ...Object.keys(deliveryReasons).map((key) => v.literal(key as keyof typeof deliveryReasons)),
);
export type DeliveryReason = keyof typeof deliveryReasons;
export const noticeStatus = v.union(
  v.literal("none"),
  v.literal("queued"),
  v.literal("sending"),
  v.literal("retrying"),
  v.literal("sent"),
  v.literal("failed"),
  v.literal("uncertain"),
  v.literal("cancelled"),
);
export const noticeStatuses = {
  none: "Aucun envoi",
  queued: "En attente d’envoi",
  sending: "Envoi démarré",
  retrying: "Vérification de l’envoi",
  sent: "Acceptée par le service d’envoi",
  failed: "Échec de l’envoi",
  uncertain: "Envoi incertain",
  cancelled: "Envoi annulé",
} as const;
export const noticeFields = {
  shopId: v.id("shops"),
  orderGid: v.string(),
  orderId: v.id("shopifyOrders"),
  orderName: v.string(),
  email: v.optional(v.string()),
  placedAt: v.number(),
  promise: v.object(promiseFields),
  deadlineAt: v.number(),
  estimated: v.boolean(),
  expiresAt: v.number(),
  status: noticeStatus,
  reason: deliveryReason,
  attention: v.boolean(),
  wasOverdue: v.boolean(),
  evaluatedMode: deliveryMode,
  createdAt: v.number(),
  updatedAt: v.number(),
  attempts: v.number(),
  revision: v.optional(v.number()),
  nextAttemptAt: v.optional(v.number()),
  token: v.optional(v.string()),
  acceptanceUncertain: v.optional(v.boolean()),
  payload: v.optional(emailPayload),
  contextKey: v.optional(v.string()),
  replyToken: v.optional(v.string()),
  routeId: v.optional(v.id("inboundEmailRoutes")),
  conversationId: v.optional(v.id("supportConversations")),
  cancelledBy: v.optional(v.id("profiles")),
  sendDeadline: v.optional(v.number()),
  providerId: v.optional(v.string()),
  sentAt: v.optional(v.number()),
};
export const DAY = 86_400_000;
export const NOTICE_LEASE = 120_000;
export const NOTICE_WINDOW = 2 * 3600_000;

export function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
export function validDay(day: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
  );
}
export function validDeliveryConfig(config: DeliveryConfig) {
  return (
    Number.isInteger(config.maxDays) &&
    config.maxDays >= 1 &&
    config.maxDays <= 90 &&
    Number.isInteger(config.hour) &&
    config.hour >= 0 &&
    config.hour <= 23 &&
    validTimezone(config.timezone) &&
    config.holidays.length <= 80 &&
    config.holidays.every(validDay) &&
    new Set(config.holidays).size === config.holidays.length
  );
}
function localParts(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const part = (name: string) => parts.find((p) => p.type === name)?.value ?? "00";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    second: Number(part("second")),
  };
}
function addDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
export function localTime(date: string, hour: number, timezone: string) {
  const target = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  let guess = target,
    previous = target;
  for (let i = 0; i < 5; i++) {
    const parts = localParts(guess, timezone);
    const actual = Date.parse(
      `${parts.date}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}Z`,
    );
    const next = guess + target - actual;
    if (next === guess) return guess;
    // Spring DST gap: choose the first valid time after the missing hour.
    if (next === previous && i > 0) return Math.max(guess, next);
    previous = guess;
    guess = next;
  }
  return guess;
}
export function nextDeliveryRun(now: number, timezone: string, hour: number) {
  const date = localParts(now, timezone).date,
    today = localTime(date, hour, timezone);
  return today > now ? today : localTime(addDate(date, 1), hour, timezone);
}
export function deliveryDeadline(
  placedAt: number,
  policy: Pick<DeliveryConfig, "maxDays" | "calendar" | "timezone" | "holidays">,
) {
  let date = localParts(placedAt, policy.timezone).date,
    remaining = policy.maxDays;
  while (remaining > 0) {
    date = addDate(date, 1);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (
      policy.calendar === "calendar" ||
      (weekday !== 0 && weekday !== 6 && !policy.holidays.includes(date))
    )
      remaining--;
  }
  return localTime(addDate(date, 1), 0, policy.timezone) - 1;
}
export function delayEmail(
  locale: Infer<typeof deliveryLocale>,
  orderName: string,
  shopName: string,
) {
  const order = orderName.replace(/[\r\n]/g, " ").slice(0, 100),
    shop = shopName.replace(/[\r\n]/g, " ").slice(0, 100);
  const copy = {
    fr: {
      subject: `Des nouvelles de votre commande ${order}`,
      text: `Bonjour,\n\nLe délai de livraison annoncé pour votre commande ${order} est dépassé et nos dernières informations ne confirment pas encore sa livraison complète. Nous sommes désolés pour cette attente.\n\nNous souhaitions vous en informer sans attendre votre demande. Vous pouvez répondre directement à cet email pour contacter notre équipe.\n\nCordialement,\n${shop}`,
    },
    en: {
      subject: `An update on your order ${order}`,
      text: `Hello,\n\nThe announced delivery timeframe for your order ${order} has passed, and our latest information does not yet confirm that it has been fully delivered. We are sorry for the wait.\n\nWe wanted to let you know proactively. You can reply directly to this email to contact our team.\n\nKind regards,\n${shop}`,
    },
    es: {
      subject: `Información sobre tu pedido ${order}`,
      text: `Hola:\n\nEl plazo de entrega anunciado para tu pedido ${order} ha pasado y nuestra última información todavía no confirma su entrega completa. Sentimos la espera.\n\nQueríamos informarte sin esperar a que nos contactaras. Puedes responder directamente a este correo para contactar con nuestro equipo.\n\nUn saludo,\n${shop}`,
    },
  };
  return copy[locale];
}
