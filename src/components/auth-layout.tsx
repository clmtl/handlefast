import { useNavigate } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import type { ReactNode } from "react";
import { useEffect } from "react";

export function AuthPage({
  children,
  eyebrow,
  title,
  subtitle,
}: Readonly<{
  children: ReactNode;
  eyebrow: string;
  title: string;
  subtitle: string;
}>) {
  return (
    <main className="grid min-h-dvh bg-background text-foreground lg:grid-cols-[1fr_480px]">
      <section className="flex min-h-[42dvh] flex-col justify-between border-b bg-card px-6 py-8 lg:min-h-dvh lg:border-r lg:border-b-0 lg:px-10">
        <div className="text-lg font-semibold">HandleFast</div>
        <div className="max-w-2xl py-12 lg:py-0">
          <div className="text-sm font-medium text-primary">{eyebrow}</div>
          <h1 className="mt-4 text-4xl font-semibold tracking-normal text-balance md:text-5xl">
            {title}
          </h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">{subtitle}</p>
        </div>
        <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3 lg:grid-cols-1">
          <span>Multi-shop accounts</span>
          <span>Secure support workflows</span>
          <span>Ready for email and Shopify</span>
        </div>
      </section>
      <section className="flex items-center justify-center px-5 py-8">
        <div className="w-full max-w-sm">{children}</div>
      </section>
    </main>
  );
}

export function RequireAuth({ children }: Readonly<{ children: ReactNode }>) {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useConvexAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      void navigate({ replace: true, to: "/sign-in" });
    }
  }, [isAuthenticated, isLoading, navigate]);

  if (isLoading) {
    return <LoadingScreen label="Checking your session" />;
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

export function LoadingScreen({ label }: Readonly<{ label: string }>) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5 text-foreground">
      <div className="rounded-md border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
        {label}
      </div>
    </main>
  );
}

export function FieldError({ children }: Readonly<{ children?: ReactNode }>) {
  if (!children) {
    return null;
  }

  return <p className="text-sm text-destructive">{children}</p>;
}
