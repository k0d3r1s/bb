import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Thread } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { DetailRow } from "@/components/ui/detail-card";
import { sdk } from "@/lib/sdk";

export function BranchPromotionRow({ thread }: { thread: Thread }) {
  const [inspect, setInspect] = useState(false);
  const query = useQuery({
    queryKey: ["branch-promotion", thread.id],
    queryFn: ({ signal }) =>
      sdk.threads.inspectBranchPromotion({ threadId: thread.id, signal }),
    enabled: inspect && thread.promotionTarget === "branch",
    retry: false,
  });
  const resolve = useMutation({
    mutationFn: (resolution: "accept-current" | "keep-current") => {
      const operation = query.data;
      if (!operation?.snapshot)
        throw new Error("Inspect the checkout before resolving.");
      return sdk.threads.resolveBranchPromotion({
        threadId: thread.id,
        operationId: operation.operationId,
        observation: operation.snapshot.observation,
        resolution,
      });
    },
    onSuccess: () => {
      void query.refetch();
    },
  });
  const operation = query.data;
  const snapshot = operation?.snapshot;
  const pending =
    operation !== null &&
    operation !== undefined &&
    !["completed", "failed"].includes(operation.phase);
  const busy = query.isFetching || resolve.isPending;
  const error = resolve.error ?? query.error;
  return (
    <DetailRow label="Checkout promotion">
      <div className="flex min-w-0 flex-col gap-2">
        <span>
          {thread.promotionTarget} · {thread.worktreePromotion}
        </span>
        {thread.promotionTarget === "branch" && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                resolve.reset();
                setInspect(true);
                if (inspect) void query.refetch();
              }}
            >
              Inspect branch promotion
            </Button>
            {error && <p role="alert">{error.message}</p>}
            {inspect && query.isSuccess && !operation && (
              <p>No branch promotion has started.</p>
            )}
            {operation && (
              <div className="flex flex-col gap-2">
                <span>
                  {operation.phase}: {snapshot?.branchName ?? "Unknown branch"}
                </span>
                <span className="break-all">{operation.intent.path}</span>
                {snapshot?.headSha && (
                  <span className="break-all">{snapshot.headSha}</span>
                )}
                <span>Requested branch: {operation.intent.target.name}</span>
                {snapshot?.message && <p>{snapshot.message}</p>}
                {pending && (
                  <>
                    <p>
                      Accept the observed checkout after the original Git
                      command has terminated. These actions do not switch,
                      reset, or delete branches.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy ||
                        !snapshot?.commandTerminated ||
                        snapshot.branchName !== operation.intent.target.name
                      }
                      onClick={() => resolve.mutate("accept-current")}
                    >
                      Accept current target
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !snapshot?.commandTerminated}
                      onClick={() => resolve.mutate("keep-current")}
                    >
                      Keep current checkout and skip promotion
                    </Button>
                    {!snapshot?.commandTerminated && (
                      <p>
                        Reconnect the host and inspect again to confirm the
                        command has stopped.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </DetailRow>
  );
}
