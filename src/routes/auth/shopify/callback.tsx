import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { RequireAuth } from "@/components/auth-layout";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export const Route = createFileRoute("/auth/shopify/callback")({
  component: () => (
    <RequireAuth>
      <Callback />
    </RequireAuth>
  ),
});
function Callback() {
  const complete = useAction(api.shopifyGuidedActions.callback),
    navigate = useNavigate();
  const [error, setError] = useState(false),
    pending = useRef<Promise<Id<"shops">> | null>(null);
  useEffect(() => {
    let disposed = false;
    if (!pending.current) pending.current = complete({ query: window.location.search.slice(1) });
    void pending.current
      .then((shopId) => {
        if (disposed) return;
        sessionStorage.removeItem(`handlefast:shopify-guided:${shopId}`);
        void navigate({ to: "/dashboard", replace: true });
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => {
      disposed = true;
    };
  }, [complete, navigate]);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-5">
      <section className="max-w-lg rounded-lg border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {error ? "Installation à vérifier" : "Connexion de votre boutique…"}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {error
            ? "L’installation n’a pas pu être confirmée. Revenez au tableau de bord pour reprendre la connexion avec le même compte HandleFast."
            : "Nous vérifions l’installation et rattachons la boutique à votre organisation HandleFast."}
        </p>
        {error && (
          <a className="mt-5 inline-block text-sm text-primary underline" href="/dashboard">
            Revenir au tableau de bord
          </a>
        )}
      </section>
    </main>
  );
}
