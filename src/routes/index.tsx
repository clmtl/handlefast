import { convexQuery } from "@convex-dev/react-query";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMutation } from "convex/react";
import {
  BadgeCheck,
  Cloud,
  Database,
  Languages,
  Mail,
  ShieldCheck,
  Table2,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { appStore } from "@/lib/app-store";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages.js";
import { api } from "../../convex/_generated/api";

export const Route = createFileRoute("/")({
  component: Home,
});

type Integration = {
  name: string;
  role: string;
  status: "ready" | "configured" | "needs-secrets";
};

const integrations: Integration[] = [
  { name: "TanStack Start", role: "React full-stack framework", status: "ready" },
  { name: "Convex", role: "Backend and database", status: "configured" },
  { name: "Cloudflare", role: "Frontend hosting on Workers", status: "configured" },
  { name: "Better Auth", role: "Authentication layer", status: "needs-secrets" },
  { name: "Sentry", role: "Client and Worker monitoring", status: "needs-secrets" },
  { name: "Paraglide", role: "Typed i18n messages", status: "ready" },
];

const columnHelper = createColumnHelper<Integration>();

function Home() {
  const launchMode = useStore(appStore, (state) => state.launchMode);
  const [submittedEmail, setSubmittedEmail] = useState("");
  const savePreference = useMutation(api.launchPreferences.save);
  const recentPreferences = useQuery(convexQuery(api.launchPreferences.recent, { limit: 3 }));

  const form = useForm({
    defaultValues: {
      email: "",
    },
    onSubmit: async ({ value }) => {
      await savePreference({ email: value.email, source: "home" });
      setSubmittedEmail(value.email);
    },
  });

  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        header: "Stack",
        cell: (info) => <span className="font-medium">{info.getValue()}</span>,
      }),
      columnHelper.accessor("role", {
        header: "Role",
      }),
      columnHelper.accessor("status", {
        header: "Status",
        cell: (info) => <StatusPill status={info.getValue()} />,
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: integrations,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <section className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-10 md:px-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div className="max-w-3xl">
              <div className="mb-4 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Zap className="size-4 text-amber-500" aria-hidden="true" />
                {m.app_eyebrow()}
              </div>
              <h1 className="text-4xl font-semibold tracking-normal text-balance md:text-6xl">
                {m.home_title()}
              </h1>
              <p className="mt-4 max-w-2xl text-lg leading-8 text-muted-foreground">
                {m.home_subtitle()}
              </p>
            </div>
            <button
              type="button"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
              onClick={() =>
                appStore.setState((state) => ({
                  ...state,
                  launchMode: state.launchMode === "quiet" ? "fast" : "quiet",
                }))
              }
            >
              <BadgeCheck className="size-4" aria-hidden="true" />
              {launchMode === "quiet" ? m.mode_quiet() : m.mode_fast()}
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StackSignal icon={Cloud} label="Cloudflare" value="Worker SSR" />
            <StackSignal icon={Database} label="Convex" value="Realtime DB" />
            <StackSignal icon={ShieldCheck} label="Better Auth" value="Convex adapter" />
            <StackSignal icon={Languages} label="Paraglide" value="en / fr" />
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-5 px-5 py-8 md:grid-cols-[1.1fr_0.9fr] md:px-8">
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="mb-5 flex items-center gap-2">
            <Table2 className="size-5 text-emerald-600" aria-hidden="true" />
            <h2 className="text-xl font-semibold">{m.stack_table_title()}</h2>
          </div>
          <div className="overflow-hidden rounded-md border">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-muted text-muted-foreground">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th key={header.id} className="px-4 py-3 font-medium">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="border-t">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-3">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="mb-5 flex items-center gap-2">
            <Mail className="size-5 text-sky-600" aria-hidden="true" />
            <h2 className="text-xl font-semibold">{m.form_title()}</h2>
          </div>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void form.handleSubmit();
            }}
          >
            <form.Field
              name="email"
              validators={{
                onChange: ({ value }) =>
                  value.includes("@") ? undefined : m.email_validation_error(),
              }}
            >
              {(field) => (
                <label className="grid gap-2 text-sm font-medium">
                  {m.email_label()}
                  <input
                    className="h-11 rounded-md border bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                    name={field.name}
                    type="email"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder="you@company.com"
                  />
                  {field.state.meta.errors.length > 0 ? (
                    <span className="text-sm text-destructive">
                      {field.state.meta.errors.join(", ")}
                    </span>
                  ) : null}
                </label>
              )}
            </form.Field>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
              {([canSubmit, isSubmitting]) => (
                <button
                  type="submit"
                  className="inline-flex h-11 items-center justify-center rounded-md bg-secondary px-4 text-sm font-medium text-secondary-foreground transition hover:bg-secondary/80 disabled:pointer-events-none disabled:opacity-50"
                  disabled={!canSubmit}
                >
                  {isSubmitting ? m.form_submitting() : m.form_submit()}
                </button>
              )}
            </form.Subscribe>
          </form>
          <p className="mt-4 min-h-6 text-sm text-muted-foreground">
            {submittedEmail
              ? m.form_success({ email: submittedEmail })
              : m.form_hint({
                  count: recentPreferences.data?.count ?? 0,
                })}
          </p>
        </div>
      </section>
    </main>
  );
}

function StackSignal({
  icon: Icon,
  label,
  value,
}: Readonly<{
  icon: typeof Cloud;
  label: string;
  value: string;
}>) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <Icon className="mb-3 size-5 text-primary" aria-hidden="true" />
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-1 text-sm text-muted-foreground">{value}</div>
    </div>
  );
}

function StatusPill({ status }: Readonly<{ status: Integration["status"] }>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium",
        status === "ready" && "bg-emerald-500/12 text-emerald-700",
        status === "configured" && "bg-sky-500/12 text-sky-700",
        status === "needs-secrets" && "bg-amber-500/12 text-amber-700",
      )}
    >
      {status}
    </span>
  );
}
