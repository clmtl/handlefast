import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Mail, ShieldCheck, Store } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <section className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-10 md:px-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div className="max-w-3xl">
              <div className="mb-4 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
                SaaS foundation
              </div>
              <h1 className="text-4xl font-semibold tracking-normal text-balance md:text-6xl">
                HandleFast starts with a secure workspace.
              </h1>
              <p className="mt-4 max-w-2xl text-lg leading-8 text-muted-foreground">
                Create an account, set up your first organization and shop, then connect the support
                automations that come next.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
                to="/sign-up"
              >
                Get started
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <Link
                className="inline-flex h-11 items-center justify-center rounded-md border bg-background px-5 text-sm font-medium transition hover:bg-muted"
                to="/sign-in"
              >
                Sign in
              </Link>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Signal icon={ShieldCheck} label="Auth" value="Email/password with Better Auth" />
            <Signal icon={Store} label="Tenancy" value="Organizations, roles and shops" />
            <Signal icon={Mail} label="Support" value="Ready for inbound email routing" />
          </div>
        </div>
      </section>
    </main>
  );
}

function Signal({
  icon: Icon,
  label,
  value,
}: Readonly<{
  icon: typeof ShieldCheck;
  label: string;
  value: string;
}>) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <Icon className="mb-3 size-5 text-primary" aria-hidden="true" />
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-1 text-sm text-muted-foreground">{value}</div>
    </div>
  );
}
