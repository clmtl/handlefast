import { createFileRoute, Link } from "@tanstack/react-router";
import { MailCheck, UserPlus } from "lucide-react";
import { useState } from "react";
import { AuthPage, FieldError } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/sign-up")({
  component: SignUp,
});

function SignUp() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isVerificationSent, setIsVerificationSent] = useState(false);

  if (isVerificationSent) {
    return (
      <AuthPage
        subtitle="Ouvre le lien de vérification envoyé par email, puis connecte-toi à ton espace."
        title="Vérifie ton adresse email"
      >
        <div className="grid gap-5 text-center">
          <MailCheck className="mx-auto size-10 text-primary" aria-hidden="true" />
          <Link
            className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            to="/sign-in"
          >
            Revenir à la connexion
          </Link>
        </div>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      subtitle="Ton espace sera créé automatiquement après vérification de ton email."
      title="Créer un compte"
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="name">
            Nom
          </label>
          <Input
            autoComplete="name"
            className="h-11"
            id="name"
            onChange={(event) => setName(event.target.value)}
            placeholder="Clement"
            type="text"
            value={name}
          />
        </div>
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
            autoComplete="new-password"
            className="h-11"
            id="password"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </div>
        <FieldError>{error}</FieldError>
        <Button className="h-11" disabled={isSubmitting} type="submit">
          <UserPlus className="size-4" aria-hidden="true" />
          {isSubmitting ? "Création du compte…" : "Créer un compte"}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Tu as déjà un compte ?{" "}
          <Link className="font-medium text-primary hover:underline" to="/sign-in">
            Se connecter
          </Link>
        </p>
      </form>
    </AuthPage>
  );

  async function handleSubmit() {
    setError("");

    if (password.length < 8) {
      setError("Utilise au moins 8 caractères pour ton mot de passe.");
      return;
    }

    setIsSubmitting(true);

    const result = await authClient.signUp.email({
      callbackURL: "/onboarding",
      email,
      name: name.trim() || email,
      password,
    });

    setIsSubmitting(false);

    if (result.error) {
      setError(result.error.message ?? "Impossible de créer le compte.");
      return;
    }

    setIsVerificationSent(true);
  }
}
