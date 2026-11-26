import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { AuthPage, FieldError, LoadingScreen, RequireAuth } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { api } from "../../convex/_generated/api";

export const Route = createFileRoute("/onboarding")({
  component: () => (
    <RequireAuth>
      <Onboarding />
    </RequireAuth>
  ),
});

function Onboarding() {
  const navigate = useNavigate();
  const viewer = useQuery(api.viewer.me);
  const bootstrap = useMutation(api.onboarding.bootstrap);
  const attempted = useRef(false);
  const [failed, setFailed] = useState(false);
  const ready = viewer?.hasCompletedOnboarding;

  useEffect(() => {
    if (ready) {
      void navigate({ replace: true, to: "/dashboard" });
    } else if (ready === false && !attempted.current) {
      attempted.current = true;
      void bootstrap({}).catch(() => setFailed(true));
    }
  }, [bootstrap, navigate, ready]);

  if (!failed || ready) return <LoadingScreen label="Préparation de ton espace…" />;
  return (
    <AuthPage
      title="Préparation de ton espace"
      subtitle="Relance la création pour accéder à ton dashboard."
    >
      <div className="grid gap-4">
        <FieldError>Ton espace n’a pas pu être créé.</FieldError>
        <Button
          onClick={() => {
            setFailed(false);
            void bootstrap({}).catch(() => setFailed(true));
          }}
        >
          Réessayer
        </Button>
      </div>
    </AuthPage>
  );
}
