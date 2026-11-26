import { usePaginatedQuery, useQuery } from "convex/react";
import { ChevronRight, ListChecks } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { categories, priorities } from "../../convex/lib/emailClassificationPolicy";
import { reviewStatuses } from "../../convex/lib/humanReviewPolicy";
import { EmailReaderDialog } from "./email-reader-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

type Status = keyof typeof reviewStatuses;

export function HumanReviewInbox({
  shopId,
  initialStatus = "open",
}: {
  shopId: Id<"shops">;
  initialStatus?: Status;
}) {
  const [asOf] = useState(Date.now);
  const [status, setStatus] = useState<Status>(initialStatus);
  const counts = useQuery(api.humanReviews.overview, { shopId, asOf });
  return (
    <Card className="gap-0 py-0" aria-label="Demandes à traiter">
      <Tabs value={status} onValueChange={(value) => setStatus(value as Status)} className="gap-0">
        <div className="border-b p-4 sm:px-5">
          <TabsList aria-label="État des demandes">
            {Object.entries(reviewStatuses).map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
                {counts && value !== "resolved" && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {value === "open"
                      ? `${counts.open}${counts.openMore ? "+" : ""}`
                      : `${counts.inProgress}${counts.inProgressMore ? "+" : ""}`}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={status}>
          <ReviewList key={status} shopId={shopId} status={status} asOf={asOf} />
        </TabsContent>
      </Tabs>
    </Card>
  );
}

function ReviewList({
  shopId,
  status,
  asOf,
}: {
  shopId: Id<"shops">;
  status: Status;
  asOf: number;
}) {
  const {
    results,
    status: loading,
    loadMore,
  } = usePaginatedQuery(api.humanReviews.list, { shopId, status, asOf }, { initialNumItems: 20 });
  const [selected, setSelected] = useState<Id<"emailReceipts"> | null>(null);
  return (
    <>
      {loading === "LoadingFirstPage" ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        !results.length && (
          <div className="grid justify-items-center gap-2 p-12 text-center">
            <ListChecks className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Aucune demande dans cette vue.</p>
          </div>
        )
      )}
      <ul className="divide-y">
        {results.map((item) => (
          <li key={item.receiptId}>
            <button
              type="button"
              className="flex w-full items-center gap-4 p-4 text-left hover:bg-muted/40 sm:px-5"
              onClick={() => setSelected(item.receiptId)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{item.subject}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {item.from} · {new Date(item.receivedAt).toLocaleDateString("fr-FR")}
                </span>
                <span className="mt-1.5 block line-clamp-2 text-sm text-muted-foreground">
                  {item.summary ??
                    (item.pending ? "Résumé en préparation…" : "Ouvrir pour traiter la demande.")}
                </span>
                <span className="mt-2 flex flex-wrap gap-1.5">
                  {item.category && <Badge variant="outline">{categories[item.category]}</Badge>}
                  {item.priority && (
                    <Badge
                      variant="secondary"
                      className={
                        item.priority === "urgent"
                          ? "bg-red-50 text-red-800"
                          : item.priority === "high"
                            ? "bg-amber-50 text-amber-800"
                            : undefined
                      }
                    >
                      {priorities[item.priority]}
                    </Badge>
                  )}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {(loading === "CanLoadMore" || loading === "LoadingMore") && (
        <div className="border-t p-4">
          <Button
            variant="outline"
            disabled={loading === "LoadingMore"}
            onClick={() => loadMore(20)}
          >
            Afficher la suite
          </Button>
        </div>
      )}
      <EmailReaderDialog selected={selected} close={() => setSelected(null)} />
    </>
  );
}
