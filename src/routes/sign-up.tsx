import { createFileRoute, Link } from "@tanstack/react-router";
import { MailCheck, UserPlus } from "lucide-react";
import { useState } from "react";
import { AuthPage, FieldError } from "@/components/auth-layout";
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
        eyebrow="Verify your email"
        subtitle="Open the verification link sent to your inbox, then sign in to continue onboarding."
        title="Check your inbox to finish."
      >
        <div className="grid gap-5 text-center">
          <MailCheck className="mx-auto size-10 text-primary" aria-hidden="true" />
          <Link
            className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            to="/sign-in"
          >
            Back to sign in
          </Link>
        </div>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      eyebrow="Create your workspace"
      subtitle="Start with one owner account. Your first organization and shop are created during onboarding."
      title="Build the foundation for faster support."
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
            Name
          </label>
          <input
            autoComplete="name"
            className="h-11 rounded-md border bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
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
          <input
            autoComplete="email"
            className="h-11 rounded-md border bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
            id="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            type="email"
            value={email}
          />
        </div>
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="password">
            Password
          </label>
          <input
            autoComplete="new-password"
            className="h-11 rounded-md border bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
            id="password"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </div>
        <FieldError>{error}</FieldError>
        <button
          className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          disabled={isSubmitting}
          type="submit"
        >
          <UserPlus className="size-4" aria-hidden="true" />
          {isSubmitting ? "Creating account" : "Create account"}
        </button>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link className="font-medium text-primary hover:underline" to="/sign-in">
            Sign in
          </Link>
        </p>
      </form>
    </AuthPage>
  );

  async function handleSubmit() {
    setError("");

    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
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
      setError(result.error.message ?? "Unable to create this account.");
      return;
    }

    setIsVerificationSent(true);
  }
}
