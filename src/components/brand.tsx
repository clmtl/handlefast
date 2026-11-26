import { Link } from "@tanstack/react-router";
import { Zap } from "lucide-react";

export function Brand() {
  return (
    <Link to="/" className="inline-flex items-center gap-2.5 font-semibold tracking-tight">
      <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
        <Zap className="size-4 fill-current" aria-hidden="true" />
      </span>
      HandleFast
    </Link>
  );
}
