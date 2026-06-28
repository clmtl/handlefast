import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { LogOut, Settings, ShieldCheck, Store } from "lucide-react";
import { useEffect } from "react";
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

  useEffect(() => {
    if (viewer && !viewer.hasCompletedOnboarding) {
      void navigate({ replace: true, to: "/onboarding" });
    }
  }, [navigate, viewer]);

  if (viewer === undefined || !viewer.hasCompletedOnboarding) {
    return <LoadingScreen label="Loading your workspace" />;
  }

  const organization = viewer.organizations[0];
  const membership = viewer.memberships[0];
  const shop = viewer.shops[0];
  const settings = viewer.shopSettings[0];

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
          icon={Settings}
          label="Auto-replies"
          value={settings?.autoReplyEnabled ? "Enabled" : "Disabled"}
        />
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 pb-10 md:px-8">
        <div className="rounded-lg border bg-card p-5">
          <h1 className="text-2xl font-semibold tracking-normal">Workspace foundation ready</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Authentication, tenant ownership, shop scoping, and default support settings are in
            place. The next feature can safely attach inbound emails to this shop.
          </p>
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
