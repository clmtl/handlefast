import { useNavigate } from "@tanstack/react-router";
import { useConvexAuth } from "convex/react";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { Brand } from "./brand";
import { Card, CardContent, CardHeader } from "./ui/card";

export function AuthPage({
  children,
  title,
  subtitle,
}: Readonly<{
  children: ReactNode;
  title: string;
  subtitle: string;
}>) {
  return (
    <main lang="fr" className="hf-dashboard flex min-h-dvh flex-col bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-7xl px-5 py-4 sm:px-8">
          <Brand />
        </div>
      </header>
      <div className="grid flex-1 place-items-center px-4 py-8 sm:py-12">
        <Card className="w-full max-w-md border-border shadow-lg shadow-primary/5">
          <CardHeader>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
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
    return <LoadingScreen label="Vérification de ta session…" />;
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

export function LoadingScreen({ label }: Readonly<{ label: string }>) {
  return (
    <main
      lang="fr"
      className="hf-dashboard flex min-h-dvh items-center justify-center bg-background px-5 text-foreground"
    >
      <div
        role="status"
        className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm"
      >
        <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden="true" />
        {label}
      </div>
    </main>
  );
}

export function FieldError({ children }: Readonly<{ children?: ReactNode }>) {
  if (!children) {
    return null;
  }

  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}
