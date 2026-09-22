import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  branchPromotionIntentSchema,
  branchPromotionSnapshotSchema,
  type BranchPromotionIntent,
  type BranchPromotionSnapshot,
} from "@bb/domain/branch-promotion";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import {
  branchPromotions,
  environments,
  projects,
  threads,
} from "../schema.js";

type Connection = DbConnection | DbTransaction;
export type BranchPromotionRow = typeof branchPromotions.$inferSelect;

export function getThreadBranchPromotion(
  db: Connection,
  threadId: string,
): BranchPromotionRow | null {
  return (
    db
      .select()
      .from(branchPromotions)
      .where(eq(branchPromotions.threadId, threadId))
      .orderBy(desc(branchPromotions.createdAt), desc(branchPromotions.id))
      .get() ?? null
  );
}

export function getActiveBranchPromotion(
  db: Connection,
  threadId: string,
): BranchPromotionRow | null {
  return (
    db
      .select()
      .from(branchPromotions)
      .where(
        and(
          eq(branchPromotions.threadId, threadId),
          isNull(branchPromotions.settledAt),
        ),
      )
      .get() ?? null
  );
}

export function listUnsettledBranchPromotions(
  db: Connection,
): BranchPromotionRow[] {
  return db
    .select()
    .from(branchPromotions)
    .where(isNull(branchPromotions.settledAt))
    .all();
}

export function assertBranchPromotionEnvironmentAvailable(
  db: Connection,
  environmentId: string,
): void {
  const environment = db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .get();
  if (!environment?.path) return;
  const claim = db
    .select({ id: branchPromotions.id })
    .from(branchPromotions)
    .where(
      and(
        eq(branchPromotions.hostId, environment.hostId),
        eq(branchPromotions.path, environment.path),
        isNull(branchPromotions.settledAt),
      ),
    )
    .get();
  if (claim)
    throw new Error(
      "Workspace branch promotion is pending; inspect and resolve it before using this checkout.",
    );
}

export function assertThreadPromotionMutable(
  db: Connection,
  threadId: string,
): void {
  if (getActiveBranchPromotion(db, threadId))
    throw new Error(
      "Branch promotion is pending; inspect and resolve it before changing the thread environment or promotion choice.",
    );
}

export function reserveBranchPromotion(
  db: DbConnection,
  args: {
    threadId: string;
    environmentId: string;
    hostId: string;
    intent: BranchPromotionIntent;
  },
): BranchPromotionRow {
  const intent = branchPromotionIntentSchema.parse(args.intent);
  return db.transaction(
    (tx) => {
      const thread = tx
        .select()
        .from(threads)
        .where(eq(threads.id, args.threadId))
        .get();
      const environment = tx
        .select()
        .from(environments)
        .where(eq(environments.id, args.environmentId))
        .get();
      if (
        !thread ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.environmentId !== args.environmentId ||
        thread.worktreePromotion !== "armed" ||
        thread.promotionTarget !== "branch"
      )
        throw new Error("Thread is no longer eligible for branch promotion.");
      const project = tx
        .select()
        .from(projects)
        .where(eq(projects.id, thread.projectId))
        .get();
      if (!project || project.deletedAt !== null || project.kind !== "standard")
        throw new Error("Branch promotion requires a live standard project.");
      if (
        !environment ||
        environment.projectId !== thread.projectId ||
        environment.status !== "ready" ||
        environment.teardownStatus !== null ||
        environment.hostId !== args.hostId ||
        environment.path !== intent.path ||
        environment.isWorktree ||
        !environment.isGitRepo ||
        environment.environmentProviderId !== "project-checkout"
      )
        throw new Error("Checkout is no longer eligible for branch promotion.");
      assertThreadPromotionMutable(tx, thread.id);
      const claim = tx
        .select({ id: environments.id })
        .from(environments)
        .where(
          and(
            eq(environments.hostId, environment.hostId),
            eq(environments.claimPath, intent.path),
            ne(environments.status, "destroyed"),
          ),
        )
        .get();
      if (claim)
        throw new Error("Workspace is being prepared by another operation.");
      const otherThread = tx
        .select({ id: threads.id })
        .from(threads)
        .innerJoin(environments, eq(threads.environmentId, environments.id))
        .where(
          and(
            eq(environments.hostId, environment.hostId),
            eq(environments.path, intent.path),
            ne(threads.id, thread.id),
            isNull(threads.archivedAt),
            isNull(threads.deletedAt),
            inArray(threads.status, ["starting", "active", "idle", "stopping"]),
          ),
        )
        .get();
      if (otherThread)
        throw new Error(
          "Cannot checkout branch while another thread is using this workspace",
        );
      const now = Math.max(
        Date.now(),
        (getThreadBranchPromotion(tx, thread.id)?.createdAt ?? 0) + 1,
      );
      tx.update(environments)
        .set({ claimPath: intent.path, updatedAt: now })
        .where(eq(environments.id, environment.id))
        .run();
      return tx
        .insert(branchPromotions)
        .values({
          id: intent.operationId,
          threadId: thread.id,
          environmentId: environment.id,
          hostId: environment.hostId,
          path: intent.path,
          intent,
          phase: "prepared",
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}

export function ownsBranchPromotionClaim(
  db: Connection,
  operation: BranchPromotionRow,
): boolean {
  const current = getActiveBranchPromotion(db, operation.threadId);
  const environment = db
    .select()
    .from(environments)
    .where(eq(environments.id, operation.environmentId))
    .get();
  const thread = db
    .select()
    .from(threads)
    .where(eq(threads.id, operation.threadId))
    .get();
  return (
    current?.id === operation.id &&
    environment?.claimPath === operation.path &&
    environment.path === operation.path &&
    environment.hostId === operation.hostId &&
    environment.status === "ready" &&
    thread?.environmentId === operation.environmentId
  );
}

export function markBranchPromotionRunning(db: Connection, id: string): void {
  db.update(branchPromotions)
    .set({ phase: "running", updatedAt: Date.now() })
    .where(and(eq(branchPromotions.id, id), isNull(branchPromotions.settledAt)))
    .run();
}

export function recordBranchPromotionSnapshot(
  db: DbConnection,
  notifier: DbNotifier,
  operation: BranchPromotionRow,
  input: BranchPromotionSnapshot,
  defaultBranch?: string | null,
): BranchPromotionRow {
  const snapshot = branchPromotionSnapshotSchema.parse(input);
  if (snapshot.operationId !== operation.id)
    throw new Error("Branch promotion response does not match its operation.");
  const result = db.transaction(
    (tx) => {
      const current = tx
        .select()
        .from(branchPromotions)
        .where(eq(branchPromotions.id, operation.id))
        .get();
      if (!current) throw new Error("Branch promotion no longer exists.");
      if (current.settledAt !== null) return current;
      if (!ownsBranchPromotionClaim(tx, current))
        throw new Error(
          "Branch promotion reservation changed before settlement.",
        );
      const terminal =
        snapshot.commandTerminated &&
        ["completed", "failed", "resolved"].includes(snapshot.phase);
      const promoted =
        snapshot.phase === "completed" ||
        (snapshot.phase === "resolved" &&
          snapshot.resolution === "accept-current");
      const declined =
        snapshot.phase === "resolved" && snapshot.resolution === "keep-current";
      if (promoted && snapshot.branchName !== current.intent.target.name)
        throw new Error(
          "Checkout moved after promotion; inspect and resolve the observed state.",
        );
      const now = Date.now();
      if (terminal) {
        tx.update(environments)
          .set({
            claimPath: null,
            branchName: snapshot.branchName,
            ...(defaultBranch === undefined ? {} : { defaultBranch }),
            updatedAt: now,
          })
          .where(eq(environments.id, current.environmentId))
          .run();
        if (promoted || declined)
          tx.update(threads)
            .set({
              worktreePromotion: promoted ? "promoted" : "declined",
              updatedAt: now,
            })
            .where(eq(threads.id, current.threadId))
            .run();
      }
      return tx
        .update(branchPromotions)
        .set({
          snapshot,
          phase: terminal ? (promoted ? "completed" : "failed") : "reconciling",
          settledAt: terminal ? now : null,
          updatedAt: now,
        })
        .where(eq(branchPromotions.id, current.id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
  notifier.notifyThread(operation.threadId, ["environment-changed"]);
  if (result.settledAt !== null)
    notifier.notifyEnvironment(operation.environmentId, ["metadata-changed"]);
  return result;
}

export function assertBranchPromotionsSettled(
  db: Connection,
  scope: { hostId: string } | { projectId: string },
): void {
  const pending = db
    .select({ id: branchPromotions.id })
    .from(branchPromotions)
    .innerJoin(threads, eq(threads.id, branchPromotions.threadId))
    .where(
      and(
        isNull(branchPromotions.settledAt),
        "hostId" in scope
          ? eq(branchPromotions.hostId, scope.hostId)
          : eq(threads.projectId, scope.projectId),
      ),
    )
    .limit(1)
    .get();
  if (pending)
    throw new Error(
      "Branch promotion is pending; inspect and resolve it before removing this host or project.",
    );
}
