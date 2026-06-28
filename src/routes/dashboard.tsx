import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Copy, Inbox, LogOut, Settings, ShieldCheck, Store } from "lucide-react";
import { useEffect, useState } from "react";
import { LoadingScreen, RequireAuth } from "@/components/auth-layout";
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
  const ensureInboundEmailRoute = useMutation(api.inboundEmailRoutes.ensureForShop);
  const [hasRequestedInboundRoute, setHasRequestedInboundRoute] = useState(false);
  const [copiedInboundAddress, setCopiedInboundAddress] = useState(false);

  useEffect(() => {
    if (viewer && !viewer.hasCompletedOnboarding) {
      void navigate({ replace: true, to: "/onboarding" });
    }
  }, [navigate, viewer]);

  const organization = viewer?.organizations[0];
  const membership = viewer?.memberships[0];
  const shop = viewer?.shops[0];
  const settings = viewer?.shopSettings[0];
  const inboundEmailRoute = shop
    ? viewer?.inboundEmailRoutes.find((route) => route.shopId === shop._id)
    : undefined;
  const canManageWorkspace = membership?.role === "owner" || membership?.role === "admin";

  useEffect(() => {
    if (!shop || inboundEmailRoute || !canManageWorkspace || hasRequestedInboundRoute) {
      return;
    }

    setHasRequestedInboundRoute(true);
    void ensureInboundEmailRoute({ shopId: shop._id });
  }, [
    canManageWorkspace,
    ensureInboundEmailRoute,
    hasRequestedInboundRoute,
    inboundEmailRoute,
    shop,
  ]);

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
        <Panel icon={Store} label="First shop" value={shop?.name ?? "Primary shop"} />
        <Panel
          icon={Inbox}
          label="Inbound email"
          value={inboundEmailRoute ? "Ready" : canManageWorkspace ? "Setting up" : "Not ready"}
        />
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 pb-10 md:px-8">
        <div className="grid gap-5 md:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-lg border bg-card p-5">
            <h1 className="text-2xl font-semibold tracking-normal">Inbound email routing</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              Forward the shop support inbox to this HandleFast address so incoming customer emails
              can be captured and attached to the workspace.
            </p>

            <div className="mt-5 grid gap-2">
              <label className="text-sm font-medium" htmlFor="inboundEmailAddress">
                HandleFast inbound address
              </label>
              <div className="flex min-h-11 items-center gap-2 rounded-md border bg-background px-3">
                <code
                  className="min-w-0 flex-1 truncate text-sm"
                  id="inboundEmailAddress"
                  title={inboundEmailRoute?.address}
                >
                  {inboundEmailRoute?.address ?? "Creating address"}
                </code>
                <button
                  aria-label="Copy inbound address"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  disabled={!inboundEmailRoute?.address}
                  onClick={() => {
                    void copyInboundAddress(inboundEmailRoute?.address, setCopiedInboundAddress);
                  }}
                  title="Copy inbound address"
                  type="button"
                >
                  <Copy className="size-4" aria-hidden="true" />
                </button>
              </div>
              <div className="min-h-5 text-sm text-muted-foreground">
                {copiedInboundAddress ? "Copied" : " "}
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-5">
            <Settings className="mb-4 size-5 text-primary" aria-hidden="true" />
            <div className="text-sm text-muted-foreground">Auto-replies</div>
            <div className="mt-1 text-xl font-semibold">
              {settings?.autoReplyEnabled ? "Enabled" : "Disabled"}
            </div>
            <div className="mt-4 text-sm leading-6 text-muted-foreground">
              Automated replies stay disabled until classification and approval rules are
              configured.
            </div>
          </div>
        </div>
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

async function copyInboundAddress(
  address: string | undefined,
  setCopiedInboundAddress: (copied: boolean) => void,
) {
  if (!address) {
    return;
  }

  await navigator.clipboard.writeText(address);
  setCopiedInboundAddress(true);
  window.setTimeout(() => setCopiedInboundAddress(false), 1600);
}
