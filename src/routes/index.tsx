import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Bot, Inbox, ListChecks, ShoppingBag, Truck } from "lucide-react";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main lang="fr" className="hf-dashboard min-h-dvh bg-background text-foreground">
      <header className="border-b bg-card">
        <nav
          aria-label="Navigation principale"
          className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-5 py-4 sm:px-8"
        >
          <Brand />
          <Button asChild variant="ghost">
            <Link to="/sign-in">Se connecter</Link>
          </Button>
        </nav>
      </header>
      <section className="mx-auto grid max-w-7xl items-center gap-10 px-5 pt-12 pb-16 sm:px-8 sm:pt-20 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16 lg:py-24">
        <div>
          <Badge variant="secondary" className="bg-accent text-accent-foreground">
            <ShoppingBag aria-hidden="true" /> SAV Shopify
          </Badge>
          <h1 className="mt-5 max-w-xl text-balance text-4xl leading-[1.08] font-semibold tracking-tight sm:text-6xl">
            Le SAV de tes boutiques, au même endroit.
          </h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground sm:text-lg">
            Retrouve tes emails, tes commandes et le suivi des colis. HandleFast prépare les
            réponses et repère les retards de livraison.
          </p>
          <Button asChild size="lg" className="mt-7">
            <Link to="/sign-up">
              Créer un compte <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <section
          aria-label="Aperçu du dashboard"
          className="overflow-hidden rounded-2xl border bg-card shadow-xl shadow-primary/5"
        >
          <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Inbox className="size-4 text-primary" aria-hidden="true" /> Espace SAV
            </span>
            <Badge variant="secondary">Aperçu</Badge>
          </div>
          <div className="bg-background p-4 sm:p-6">
            <p className="mb-4 text-lg font-semibold tracking-tight">Vue d’ensemble</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                { label: "Boîte SAV", icon: Inbox },
                { label: "À traiter", icon: ListChecks },
                { label: "Retards", icon: Truck },
              ].map(({ label, icon: Icon }) => (
                <div
                  key={label}
                  className="flex items-center gap-2 rounded-xl border bg-card p-3 text-sm font-medium"
                >
                  <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" /> {label}
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-xl border bg-card">
              <div className="flex items-center gap-3 border-b px-4 py-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-primary">
                  <Inbox className="size-4" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-semibold">Où en est ma commande ?</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Suivi de livraison</p>
                </div>
              </div>
              <div className="flex items-center gap-3 px-4 py-4 text-sm">
                <Bot className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <p className="text-muted-foreground">Brouillon prêt à relire</p>
              </div>
            </div>
          </div>
        </section>
      </section>
      <section aria-label="Fonctionnalités" className="border-t bg-card">
        <div className="mx-auto grid max-w-7xl gap-7 px-5 py-9 sm:grid-cols-3 sm:px-8">
          {[
            {
              title: "Toutes tes boutiques",
              description: "Importe tes boutiques Shopify dans un seul espace.",
              icon: ShoppingBag,
            },
            {
              title: "Des réponses à relire",
              description:
                "Consulte la commande, ajuste le brouillon et envoie-le depuis HandleFast.",
              icon: Bot,
            },
            {
              title: "Des retards à anticiper",
              description: "Repère les commandes en retard et préviens les clients concernés.",
              icon: Truck,
            },
          ].map(({ title, description, icon: Icon }) => (
            <div key={title} className="flex items-start gap-3">
              <Icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <h2 className="font-semibold">{title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
