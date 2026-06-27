import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { initClientSentry } from "@/lib/sentry";

initClientSentry();

hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
);
