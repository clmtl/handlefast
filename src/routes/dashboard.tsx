import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Inbox, LogOut, ShieldCheck, Store } from "lucide-react";
import { useEffect, useState } from "react";
import { LoadingScreen, RequireAuth } from "@/components/auth-layout";
import { AutomaticReplySettings } from "@/components/automatic-replies";
import { DeliveryMonitoring } from "@/components/delivery-monitoring";
import { EmailTriageInbox } from "@/components/email-triage-inbox";
import { HumanReviewInbox } from "@/components/human-review-inbox";
import { InboundEmailSettings } from "@/components/inbound-email-settings";
import { ShopifySettings } from "@/components/shopify-settings";
import { authClient } from "@/lib/auth-client";
import { api } from "../../convex/_generated/api";

export const Route = createFileRoute("/dashboard")({
  component: DashboardRoute,
});

function DashboardRoute() {
  return (
    <RequireAuth>
      <Dashboard />
    </RequireAuth>
  );
}

function Dashboard() {
  const navigate = useNavigate();
  const viewer = useQuery(api.viewer.me);
  const [selectedShopId, setSelectedShopId] = useState("");

  useEffect(() => {
    if (viewer && !viewer.hasCompletedOnboarding) {
      void navigate({ replace: true, to: "/onboarding" });
    }
  }, [navigate, viewer]);

  const organization = viewer?.organizations[0];
  const membership = viewer?.memberships[0];
  const shop = viewer?.shops.find((item) => item._id === selectedShopId) ?? viewer?.shops[0];
  const inboundEmailRoute = shop
    ? viewer?.inboundEmailRoutes.find((route) => route.shopId === shop._id)
    : undefined;
  if (viewer === undefined || !viewer.hasCompletedOnboarding) {
    return <LoadingScreen label="Loading your workspace" />;
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4 md:px-8">
          <div>
            <div className="text-lg font-semibold">HandleFast</div>
            <div className="text-sm text-muted-foreground">{organization?.name}</div>
          </div>
          <button
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-3 text-sm font-medium transition hover:bg-muted"
            onClick={() => {
              void signOut();
            }}
            type="button"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </header>

      <section className="mx-auto grid w-full max-w-6xl gap-5 px-5 py-8 md:grid-cols-3 md:px-8">
        <Panel icon={ShieldCheck} label="Role" value={membership?.role ?? "owner"} />
        <Panel icon={Store} label="Boutique" value={shop?.name ?? "Primary shop"} />
        <Panel
          icon={Inbox}
          label="Inbound email"
          value={
            shop?.status === "disabled"
              ? "Disabled"
              : inboundEmailRoute?.verifiedAt &&
                  inboundEmailRoute.verifiedSupportEmail === shop?.supportEmail
                ? "Forwarding verified"
                : "Setup incomplete"
          }
        />
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 pb-10 md:px-8">
        {viewer.shops.length > 1 && (
          <label className="mb-5 block text-sm font-medium">
            Boutique active
            <select
              className="ml-3 rounded-md border bg-background px-3 py-2"
              value={shop?._id ?? ""}
              onChange={(event) => setSelectedShopId(event.target.value)}
            >
              {viewer.shops.map((item) => (
                <option key={item._id} value={item._id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {shop && <DeliveryMonitoring key={`delivery:${shop._id}`} shopId={shop._id} />}
        {shop && <AutomaticReplySettings key={`automatic:${shop._id}`} shopId={shop._id} />}
        {shop && <HumanReviewInbox key={`reviews:${shop._id}`} shopId={shop._id} />}
        {shop && <ShopifySettings key={`shopify:${shop._id}`} shopId={shop._id} />}
        {shop && <EmailTriageInbox key={`triage:${shop._id}`} shopId={shop._id} />}
        {shop && <InboundEmailSettings key={shop._id} shopId={shop._id} />}
      </section>
    </main>
  );
}

function Panel({
  icon: Icon,
  label,
  value,
}: Readonly<{
  icon: typeof ShieldCheck;
  label: string;
  value: string;
}>) {
  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <Icon className="mb-4 size-5 text-primary" aria-hidden="true" />
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

async function signOut() {
  await authClient.signOut();
  window.location.assign("/sign-in");
}
