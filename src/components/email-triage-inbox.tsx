import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ChevronRight, Ellipsis, Inbox, Mail } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  type Category,
  categories,
  type Priority,
  priorities,
} from "../../convex/lib/emailClassificationPolicy";
import { ClassificationBadges } from "./email-classification";
import { EmailReaderDialog } from "./email-reader-dialog";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const buckets = { sav: "SAV", review: "À vérifier", other: "Hors SAV" } as const;
type Bucket = keyof typeof buckets;

export function EmailTriageInbox({ shopId }: { shopId: Id<"shops"> }) {
  const [bucket, setBucket] = useState<Bucket>("sav");
  const [category, setCategory] = useState<Category | "">("");
  const [priority, setPriority] = useState<Priority | "">("");
  return (
    <Card className="gap-0 py-0">
      <Tabs value={bucket} onValueChange={(value) => setBucket(value as Bucket)} className="gap-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:px-5">
          <TabsList aria-label="Classement des emails">
            {Object.entries(buckets).map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {bucket === "sav" && (
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                aria-label="Filtrer par catégorie"
                value={category}
                onChange={(event) => setCategory(event.target.value as Category | "")}
                className="max-w-56"
              >
                <NativeSelectOption value="">Catégories</NativeSelectOption>
                {Object.entries(categories).map(([value, label]) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label="Filtrer par importance"
                value={priority}
                onChange={(event) => setPriority(event.target.value as Priority | "")}
              >
                <NativeSelectOption value="">Importances</NativeSelectOption>
                {Object.entries(priorities).map(([value, label]) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {(category || priority) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCategory("");
                    setPriority("");
                  }}
                >
                  Réinitialiser
                </Button>
              )}
            </div>
          )}
        </div>
        <TabsContent value={bucket}>
          <TriageList
            key={`${shopId}:${bucket}:${category}:${priority}`}
            shopId={shopId}
            bucket={bucket}
            category={bucket === "sav" ? category || undefined : undefined}
            priority={bucket === "sav" ? priority || undefined : undefined}
          />
        </TabsContent>
      </Tabs>
    </Card>
  );
}

function TriageList({
  shopId,
  bucket,
  category,
  priority,
}: {
  shopId: Id<"shops">;
  bucket: Bucket;
  category?: Category;
  priority?: Priority;
}) {
  const [asOf] = useState(Date.now);
  const { results, status, loadMore } = usePaginatedQuery(
    api.emailTriage.list,
    { shopId, bucket, asOf, category, priority },
    { initialNumItems: 25 },
  );
  const permissions = useQuery(api.emailTriage.permissions, { shopId });
  const reclassify = useMutation(api.emailTriage.reclassify);
  const [selected, setSelected] = useState<Id<"emailReceipts"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function move(receiptId: Id<"emailReceipts">, target: Bucket) {
    setBusy(true);
    setError("");
    try {
      await reclassify({ receiptId, bucket: target });
    } catch {
      setError("Le classement n’a pas pu être modifié.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <p role="alert" className="px-5 pt-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {status === "LoadingFirstPage" ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        !results.length && (
          <div className="grid justify-items-center gap-2 p-12 text-center">
            <Inbox className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Aucun email dans cette vue.</p>
          </div>
        )
      )}
      <ul className="divide-y">
        {results.map((email) => (
          <li key={email.id} className="flex items-center px-3 hover:bg-muted/40 sm:px-5">
            <button
              type="button"
              onClick={() => setSelected(email.id)}
              className="flex min-w-0 flex-1 items-center gap-3 py-4 text-left"
            >
              <span className="hidden size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground sm:grid">
                <Mail className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{email.subject}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {email.from}
                </span>
                {email.snippet && (
                  <span className="mt-1 block truncate text-sm text-muted-foreground">
                    {email.snippet}
                  </span>
                )}
              </span>
              <time
                className="hidden whitespace-nowrap text-xs text-muted-foreground sm:block"
                dateTime={new Date(email.receivedAt).toISOString()}
              >
                {new Date(email.receivedAt).toLocaleDateString("fr-FR")}
              </time>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
            {bucket === "sav" && (
              <div className="hidden max-w-52 px-3 xl:block">
                <ClassificationBadges
                  classification={email.classification}
                  pending={email.classificationPending}
                />
              </div>
            )}
            {permissions?.canCorrect && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Déplacer ${email.subject}`}
                    disabled={busy}
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {Object.entries(buckets)
                    .filter(([value]) => value !== bucket)
                    .map(([value, label]) => (
                      <DropdownMenuItem
                        key={value}
                        onSelect={() => void move(email.id, value as Bucket)}
                      >
                        Déplacer vers {label}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>
      {(status === "CanLoadMore" || status === "LoadingMore") && (
        <div className="border-t p-4">
          <Button
            variant="outline"
            disabled={status === "LoadingMore"}
            onClick={() => loadMore(25)}
          >
            Afficher la suite
          </Button>
        </div>
      )}
      <EmailReaderDialog selected={selected} close={() => setSelected(null)} />
    </>
  );
}
