import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import { useState } from "react";
import { AuthPage, FieldError } from "@/components/auth-layout";
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
    <AuthPage
      eyebrow="Welcome back"
      subtitle="Sign in to reach your HandleFast workspace and continue setting up support operations."
      title="Access your support command center."
    >
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
            autoComplete="current-password"
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
          <LogIn className="size-4" aria-hidden="true" />
          {isSubmitting ? "Signing in" : "Sign in"}
        </button>
        <p className="text-center text-sm text-muted-foreground">
          New to HandleFast?{" "}
          <Link className="font-medium text-primary hover:underline" to="/sign-up">
            Create an account
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
      setError(result.error.message ?? "Unable to sign in with these credentials.");
      return;
    }

    await navigate({ to: "/dashboard" });
  }
}
