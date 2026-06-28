/// <reference types="vite/client" />

import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import type { ConvexQueryClient } from "@convex-dev/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouteContext,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { ComponentProps, ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { getToken } from "@/lib/auth-server";
import { getLocale } from "@/paraglide/runtime.js";
import appCss from "@/styles/app.css?url";

const getAuth = createServerFn({ method: "GET" }).handler(async () => {
  return await getToken();
});

type ConvexProviderAuthClient = ComponentProps<typeof ConvexBetterAuthProvider>["authClient"];

// @ts-expect-error @convex-dev/better-auth's AuthClient type resolves useSession().data to never with the Convex plugin, while createAuthClient returns the runtime shape consumed by the provider.
const convexProviderAuthClient: ConvexProviderAuthClient = authClient;

export const Route = createRootRouteWithContext<{
  convexQueryClient: ConvexQueryClient;
  queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: "HandleFast",
      },
      {
        name: "description",
        content: "HandleFast automates ecommerce support workflows.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  beforeLoad: async ({ context }) => {
    const token = await getAuth();

    if (token) {
      context.convexQueryClient.serverHttpClient?.setAuth(token);
    }

    return {
      isAuthenticated: Boolean(token),
      token,
    };
  },
  component: RootComponent,
});

function RootComponent() {
  const context = useRouteContext({ from: Route.id });

  return (
    <ConvexBetterAuthProvider
      authClient={convexProviderAuthClient}
      client={context.convexQueryClient.convexClient}
      initialToken={context.token}
    >
      <RootDocument>
        <Outlet />
      </RootDocument>
    </ConvexBetterAuthProvider>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang={getLocale()} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
