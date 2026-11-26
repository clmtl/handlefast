import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import {
  ArrowUpRight,
  Bot,
  ChevronRight,
  CircleCheck,
  Clock3,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  ShoppingBag,
  Store,
  Truck,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { LoadingScreen, RequireAuth } from "@/components/auth-layout";
import { AutomaticReplySettings } from "@/components/automatic-replies";
import { DeliveryMonitoring } from "@/components/delivery-monitoring";
import { EmailReaderDialog } from "@/components/email-reader-dialog";
import { EmailTriageInbox } from "@/components/email-triage-inbox";
import { HumanReviewInbox } from "@/components/human-review-inbox";
import { InboundEmailSettings } from "@/components/inbound-email-settings";
import { ShopifySettings } from "@/components/shopify-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth-client";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const sections = {
  overview: { label: "Vue d’ensemble", icon: LayoutDashboard },
  inbox: { label: "Boîte SAV", icon: Inbox },
  reviews: { label: "À traiter", icon: ListChecks },
  replies: { label: "Réponses automatiques", icon: Bot },
  deliveries: { label: "Retards de livraison", icon: Truck },
  email: { label: "Réception email", icon: Mail },
  shopify: { label: "Shopify et suivi", icon: ShoppingBag },
} as const;
type Section = keyof typeof sections;
const groups: { label: string; items: Section[] }[] = [
  { label: "Espace de travail", items: ["overview", "inbox", "reviews"] },
  { label: "Automatisations", items: ["replies", "deliveries"] },
  { label: "Connexions", items: ["email", "shopify"] },
];
const roles = {
  owner: "Propriétaire",
  admin: "Administrateur",
  agent: "Agent",
  viewer: "Lecture seule",
};

export const Route = createFileRoute("/dashboard")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { view?: Section; shop?: string; review?: "in_progress" } => ({
    view:
      typeof search.view === "string" && Object.hasOwn(sections, search.view)
        ? (search.view as Section)
        : undefined,
    shop: typeof search.shop === "string" ? search.shop : undefined,
    review: search.review === "in_progress" ? search.review : undefined,
  }),
  component: () => (
    <RequireAuth>
      <Dashboard />
    </RequireAuth>
  ),
});

function Dashboard() {
  const viewer = useQuery(api.viewer.me);
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const section = search.view ?? "overview";

  useEffect(() => {
    if (viewer && !viewer.hasCompletedOnboarding)
      void navigate({ to: "/onboarding", replace: true });
  }, [viewer, navigate]);

  if (!viewer?.hasCompletedOnboarding) return <LoadingScreen label="Chargement de ton espace…" />;
  const shop = viewer.shops.find((item) => item._id === search.shop) ?? viewer.shops[0];
  const profile = viewer.profile;
  const role = viewer.memberships.find(
    (member) => member.organizationId === shop?.organizationId,
  )?.role;

  return (
    <SidebarProvider
      className="hf-dashboard"
      style={{ "--sidebar-width": "15.5rem" } as React.CSSProperties}
    >
      <DashboardSidebar section={section} shop={search.shop} shopId={shop?._id} />
      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b bg-card px-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <SidebarTrigger aria-label="Afficher ou replier la navigation" />
            <span className="h-5 w-px bg-border" aria-hidden="true" />
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden whitespace-nowrap text-muted-foreground sm:inline">
                Espace SAV
              </span>
              <ChevronRight
                className="hidden size-3.5 text-muted-foreground sm:block"
                aria-hidden="true"
              />
              <span className="truncate font-medium">{sections[section].label}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {shop &&
              (viewer.shops.length > 1 ? (
                <NativeSelect
                  aria-label="Boutique active"
                  value={shop._id}
                  className="max-w-32 sm:max-w-48"
                  onChange={(event) =>
                    void navigate({ search: { ...search, shop: event.target.value } })
                  }
                >
                  {viewer.shops.map((item) => (
                    <NativeSelectOption key={item._id} value={item._id}>
                      {item.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <span className="hidden max-w-48 items-center gap-2 truncate rounded-lg border px-3 py-1.5 text-sm font-medium sm:flex">
                  <Store className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{shop.name}</span>
                </span>
              ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full bg-primary/10 text-primary hover:bg-primary/15"
                  aria-label="Menu du compte"
                >
                  {(profile?.name || profile?.email || "H").slice(0, 1).toUpperCase()}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium">
                    {profile?.name || profile?.email || "Mon compte"}
                  </p>
                  {role && <p className="text-xs text-muted-foreground">{roles[role]}</p>}
                </div>
                <DropdownMenuItem onSelect={() => void signOut()}>
                  <LogOut /> Se déconnecter
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <div className="mx-auto w-full max-w-[1460px] px-4 py-7 sm:px-7 lg:px-9 lg:py-9">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-[2rem]">
              {sections[section].label}
            </h1>
            {section === "overview" && (
              <p className="mt-1 text-sm text-muted-foreground">
                {shop?.name ?? viewer.organizations[0]?.name}
              </p>
            )}
          </div>
          {shop ? (
            <DashboardView
              key={`${shop._id}:${section}:${search.review ?? ""}`}
              shopId={shop._id}
              section={section}
              shop={search.shop}
              review={search.review}
            />
          ) : (
            <Card>
              <CardContent>Aucune boutique dans cet espace.</CardContent>
            </Card>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function DashboardSidebar({
  section,
  shop,
  shopId,
}: {
  section: Section;
  shop?: string;
  shopId?: Id<"shops">;
}) {
  const { setOpenMobile } = useSidebar();
  const [asOf] = useState(Date.now);
  const counts = useQuery(api.humanReviews.overview, shopId ? { shopId, asOf } : "skip");
  return (
    <Sidebar collapsible="icon" aria-label="Navigation principale">
      <SidebarHeader className="h-16 justify-center border-b border-sidebar-border px-3 group-data-[collapsible=icon]:px-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              tooltip="HandleFast"
              className="gap-2.5 hover:bg-transparent"
            >
              <Link to="/dashboard" search={{ shop }} onClick={() => setOpenMobile(false)}>
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
                  <Zap className="size-4 fill-current" aria-hidden="true" />
                </span>
                <span className="truncate text-base font-semibold tracking-tight text-foreground">
                  HandleFast
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-4 px-2 py-5 group-data-[collapsible=icon]:px-0">
        {groups.map((group) => (
          <SidebarGroup key={group.label} className="py-0">
            <SidebarGroupLabel className="text-[11px] font-semibold tracking-wide text-muted-foreground">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu className="gap-1">
              {group.items.map((view) => {
                const { icon: Icon, label } = sections[view];
                return (
                  <SidebarMenuItem key={view}>
                    <SidebarMenuButton
                      asChild
                      isActive={view === section}
                      tooltip={label}
                      className="h-9 gap-2.5 rounded-lg data-[active=true]:bg-sidebar-accent data-[active=true]:text-primary"
                    >
                      <Link
                        to="/dashboard"
                        search={{ view: view === "overview" ? undefined : view, shop }}
                        aria-current={view === section ? "page" : undefined}
                        onClick={() => setOpenMobile(false)}
                      >
                        <Icon aria-hidden="true" />
                        <span>{label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {view === "reviews" && Boolean(counts?.open) && (
                      <SidebarMenuBadge className="text-primary">
                        {counts?.open}
                        {counts?.openMore ? "+" : ""}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-3 group-data-[collapsible=icon]:p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Se déconnecter" onClick={() => void signOut()}>
              <LogOut aria-hidden="true" />
              <span>Se déconnecter</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function DashboardView({
  section,
  shopId,
  shop,
  review,
}: {
  section: Section;
  shopId: Id<"shops">;
  shop?: string;
  review?: "in_progress";
}) {
  switch (section) {
    case "inbox":
      return <EmailTriageInbox shopId={shopId} />;
    case "reviews":
      return <HumanReviewInbox shopId={shopId} initialStatus={review} />;
    case "replies":
      return <AutomaticReplySettings shopId={shopId} />;
    case "deliveries":
      return <DeliveryMonitoring shopId={shopId} />;
    case "email":
      return <InboundEmailSettings shopId={shopId} />;
    case "shopify":
      return <ShopifySettings shopId={shopId} />;
    default:
      return <Overview shopId={shopId} shop={shop} />;
  }
}

function Overview({ shopId, shop }: { shopId: Id<"shops">; shop?: string }) {
  const [asOf] = useState(Date.now);
  const counts = useQuery(api.humanReviews.overview, { shopId, asOf });
  const inbox = useQuery(api.emailTriage.list, {
    shopId,
    bucket: "sav",
    asOf,
    paginationOpts: { numItems: 5, cursor: null },
  });
  const mail = useQuery(api.emailInbox.connection, { shopId });
  const commerce = useQuery(api.shopifyConnection.status, { shopId });
  const reply = useQuery(api.automaticReplySettings.get, { shopId });
  const delivery = useQuery(api.deliveryMonitoring.get, { shopId });
  const [selected, setSelected] = useState<Id<"emailReceipts"> | null>(null);
  const emailStatus = mail
    ? mail.enabled
      ? mail.verified
        ? "Vérifiée"
        : "À vérifier"
      : mail.address
        ? "En pause"
        : "À connecter"
    : "…";
  const shopifyStatus = commerce
    ? commerce.connected
      ? commerce.error
        ? "À vérifier"
        : "Connecté"
      : "À connecter"
    : "…";
  const automations = [
    {
      view: "replies" as const,
      label: "Réponses automatiques",
      status: reply
        ? reply.enabled && reply.configured
          ? "Actives"
          : reply.enabled
            ? "À configurer"
            : "En pause"
        : "…",
    },
    {
      view: "deliveries" as const,
      label: "Retards de livraison",
      status: delivery
        ? delivery.config?.mode === "live"
          ? "Actifs"
          : delivery.config?.mode === "simulation"
            ? "Simulation"
            : delivery.config?.mode === "off"
              ? "En pause"
              : "À configurer"
        : "…",
    },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "À traiter",
            value: counts ? `${counts.open}${counts.openMore ? "+" : ""}` : null,
            icon: ListChecks,
            view: "reviews" as const,
            tone: "bg-primary/10 text-primary",
          },
          {
            label: "En cours",
            value: counts ? `${counts.inProgress}${counts.inProgressMore ? "+" : ""}` : null,
            icon: Clock3,
            view: "reviews" as const,
            tone: "bg-amber-50 text-amber-800",
          },
          {
            label: "Réception email",
            value: mail ? emailStatus : null,
            icon: Mail,
            view: "email" as const,
            tone: "bg-sky-50 text-sky-800",
          },
          {
            label: "Shopify",
            value: commerce ? shopifyStatus : null,
            icon: ShoppingBag,
            view: "shopify" as const,
            tone: "bg-emerald-50 text-emerald-800",
          },
        ].map(({ icon: Icon, ...metric }) => (
          <Link
            key={metric.label}
            to="/dashboard"
            search={{
              view: metric.view,
              shop,
              review: metric.label === "En cours" ? "in_progress" : undefined,
            }}
            className="group min-w-0 rounded-xl outline-offset-2"
          >
            <Card className="gap-0 py-0 transition-colors group-hover:border-primary/45">
              <CardContent className="px-4 py-4 sm:px-5">
                <div className="flex items-center justify-between gap-2">
                  <span className={`grid size-9 place-items-center rounded-lg ${metric.tone}`}>
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <ArrowUpRight
                    className="size-4 text-muted-foreground group-hover:text-primary"
                    aria-hidden="true"
                  />
                </div>
                <p className="mb-1 mt-3 text-sm text-muted-foreground">{metric.label}</p>
                {metric.value === null ? (
                  <Skeleton className="h-7 w-20" />
                ) : (
                  <p className="truncate text-xl font-semibold tracking-tight">{metric.value}</p>
                )}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <Card className="min-w-0 gap-0 py-0">
          <CardHeader className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-4 sm:px-5">
            <h2 className="font-semibold">Derniers emails SAV</h2>
            <Button asChild variant="ghost" size="sm">
              <Link to="/dashboard" search={{ view: "inbox", shop }}>
                Ouvrir la boîte <ChevronRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="px-0">
            {!inbox ? (
              <div className="space-y-3 p-5">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-4/5" />
              </div>
            ) : inbox.page.length ? (
              <ul className="divide-y">
                {inbox.page.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(item.id)}
                      className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/45 focus-visible:bg-muted sm:px-5"
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <Mail className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{item.subject}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {item.from}
                        </span>
                      </span>
                      <time
                        className="shrink-0 text-xs text-muted-foreground"
                        dateTime={new Date(item.receivedAt).toISOString()}
                      >
                        {new Date(item.receivedAt).toLocaleDateString("fr-FR", {
                          day: "numeric",
                          month: "short",
                        })}
                      </time>
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-9 text-center text-sm text-muted-foreground">
                Aucun email SAV pour le moment.
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="gap-0 py-0">
          <CardHeader className="border-b px-4 py-4 sm:px-5">
            <h2 className="font-semibold">Automatisations</h2>
          </CardHeader>
          <CardContent className="px-0">
            <ul className="divide-y">
              {automations.map((item) => {
                const Icon = sections[item.view].icon;
                return (
                  <li key={item.view}>
                    <Link
                      to="/dashboard"
                      search={{ view: item.view, shop }}
                      className="flex items-center gap-3 px-4 py-4 hover:bg-muted/45 sm:px-5"
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1 text-sm font-medium">{item.label}</span>
                      <Badge variant="secondary" className="shrink-0">
                        {["Actifs", "Actives"].includes(item.status) && (
                          <CircleCheck aria-hidden="true" />
                        )}
                        {item.status}
                      </Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </div>
      <EmailReaderDialog selected={selected} close={() => setSelected(null)} />
    </div>
  );
}

async function signOut() {
  await authClient.signOut();
  window.location.assign("/sign-in");
}
