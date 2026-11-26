import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, Store } from "lucide-react";
import { useEffect, useState } from "react";
import { FieldError, LoadingScreen, RequireAuth } from "@/components/auth-layout";
import { api } from "../../convex/_generated/api";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingRoute,
});

function OnboardingRoute() {
  return (
    <RequireAuth>
      <Onboarding />
    </RequireAuth>
  );
}

function Onboarding() {
  const navigate = useNavigate();
  const viewer = useQuery(api.viewer.me);
  const bootstrap = useMutation(api.onboarding.bootstrap);
  const [organizationName, setOrganizationName] = useState("");
  const [shopName, setShopName] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (viewer?.hasCompletedOnboarding) {
      void navigate({ replace: true, to: "/dashboard" });
    }
  }, [navigate, viewer?.hasCompletedOnboarding]);

  if (viewer === undefined || viewer.hasCompletedOnboarding) {
    return <LoadingScreen label="Preparing your workspace" />;
  }

  return (
    <main className="min-h-dvh bg-background px-5 py-8 text-foreground">
      <section className="mx-auto grid w-full max-w-5xl gap-8 md:grid-cols-[0.9fr_1.1fr]">
        <div className="flex flex-col justify-between rounded-lg border bg-card p-6">
          <div>
            <div className="mb-4 inline-flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Store className="size-5" aria-hidden="true" />
            </div>
            <h1 className="text-3xl font-semibold tracking-normal">Set up your first shop</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              This creates your owner membership, organization, first shop, and default support
              settings in one Convex transaction.
            </p>
          </div>
          <div className="mt-8 grid gap-3 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
              Owner role assigned automatically
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
              Auto-replies start disabled
            </div>
          </div>
        </div>

        <form
          className="rounded-lg border bg-card p-6 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <div className="grid gap-5">
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor="organizationName">
                Organization name
              </label>
              <input
                className="h-11 rounded-md border bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                id="organizationName"
                onChange={(event) => setOrganizationName(event.target.value)}
                placeholder="Acme Commerce"
                type="text"
                value={organizationName}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor="shopName">
                First shop name
              </label>
              <input
                className="h-11 rounded-md border bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                id="shopName"
                onChange={(event) => setShopName(event.target.value)}
                placeholder="Main Shopify store"
                type="text"
                value={shopName}
              />
            </div>
            <FieldError>{error}</FieldError>
            <button
              className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? "Creating workspace" : "Create workspace"}
            </button>
          </div>
        </form>
      </section>
    </main>
  );

  async function handleSubmit() {
    setError("");
    setIsSubmitting(true);

    try {
      const trimmedOrganizationName = organizationName.trim();
      const trimmedShopName = shopName.trim();

      await bootstrap({
        ...(trimmedOrganizationName ? { organizationName: trimmedOrganizationName } : {}),
        ...(trimmedShopName ? { shopName: trimmedShopName } : {}),
      });
      await navigate({ to: "/dashboard" });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to create workspace.");
    } finally {
      setIsSubmitting(false);
    }
  }
}
