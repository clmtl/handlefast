import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { useState } from "react";
import { AuthPage, FieldError } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/sign-in")({
  component: SignIn,
});

function SignIn() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <AuthPage subtitle="Retrouve tes boutiques et tes demandes SAV." title="Se connecter">
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="email">
            Email
          </label>
          <Input
            autoComplete="email"
            className="h-11"
            id="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            type="email"
            value={email}
          />
        </div>
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="password">
            Mot de passe
          </label>
          <Input
            autoComplete="current-password"
            className="h-11"
            id="password"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </div>
        <FieldError>{error}</FieldError>
        <Button className="h-11" disabled={isSubmitting} type="submit">
          <LogIn className="size-4" aria-hidden="true" />
          {isSubmitting ? "Connexion…" : "Se connecter"}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Tu découvres HandleFast ?{" "}
          <Link className="font-medium text-primary hover:underline" to="/sign-up">
            Créer un compte
          </Link>
        </p>
      </form>
    </AuthPage>
  );

  async function handleSubmit() {
    setError("");
    setIsSubmitting(true);

    const result = await authClient.signIn.email({
      email,
      password,
    });

    setIsSubmitting(false);

    if (result.error) {
      setError(result.error.message ?? "Impossible de se connecter.");
      return;
    }

    await navigate({ to: "/dashboard" });
  }
}
