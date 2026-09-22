import type { CreateThreadEnvironmentArgs } from "@bb/server-contract";
import type { WorkSessionDeps } from "../../types.js";
import type { ResolvedCreateThreadEnvironment } from "./thread-default-policy.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  branchPromotionSnapshotSchema,
  gitBranchNameSchema,
  type BranchPromotionRequest,
  type DynamicTool,
  type Thread,
  type ToolCallResponse,
} from "@bb/domain";
import {
  getThreadBranchPromotion,
  getAppSettings,
  getEnvironment,
  getProject,
  getThread,
  listUnsettledBranchPromotions,
  markBranchPromotionRunning,
  ownsBranchPromotionClaim,
  recordBranchPromotionSnapshot,
  reserveBranchPromotion,
  type BranchPromotionRow,
  type EnvironmentRow,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import {
  getNonDestroyedHostWithStatus,
  requirePublicProject,
} from "../lib/entity-lookup.js";
import {
  getEnvironmentProvider,
  invokeEnvironmentProvider,
} from "../plugins/plugin-environment-provider-registry.js";
import { buildSuggestedBranchName } from "./thread-create-helpers.js";
import { toThreadResponseFromThread } from "./thread-runtime-display.js";
import {
  threadWritableFailure,
  toolCallFailure,
  toolCallSuccess,
} from "./thread-environment-directory.js";

export const ENTER_BRANCH_TOOL_NAME = "bb_enter_branch";
export const ENTER_BRANCH_INSTRUCTIONS =
  "This thread selected Checkout, then branch. Explore read-only in this checkout, then call bb_enter_branch immediately before the first project edit or modifying command. An empty object creates a generated branch; pass branch only to select an existing local branch requested by the user. Do not ask permission for this selected promotion. On success continue in the same directory and turn, re-reading files when instructed. On refusal do not edit or use another Git mechanism to bypass it. Resolve the reported blocker first. Staying in this checkout does not decline branching; call bb_keep_checkout only when the user explicitly asks to keep the current branch or skip branching.";
export const ENTER_BRANCH_TOOL: DynamicTool = {
  name: ENTER_BRANCH_TOOL_NAME,
  description:
    "Create a branch in this checkout before editing, or switch to an existing local branch. Keeps the environment and directory. Continue this turn after success; follow re-read guidance. A refusal must be resolved before editing.",
  inputSchema: {
    type: "object",
    properties: {
      branch: {
        type: "string",
        description:
          "Existing local branch; omit to create a generated new branch.",
      },
    },
    additionalProperties: false,
  },
  presentation: {
    label: {
      pending: "Preparing checkout branch",
      completed: "Prepared checkout branch",
    },
    icon: { glyph: "GitBranch" },
  },
};

const enterBranchInputSchema = z
  .object({ branch: gitBranchNameSchema.optional() })
  .strict();
const activeOperations = new Set<string>();
const providerResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("created"),
    path: z.string(),
    resource: branchPromotionSnapshotSchema,
  }),
  z.object({ status: z.literal("failed"), message: z.string() }),
]);

function promotionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function invokeBranchOperation(
  deps: LoggedPendingInteractionWorkSessionDeps,
  operation: BranchPromotionRow,
  request: BranchPromotionRequest,
  signal: AbortSignal,
): Promise<BranchPromotionRow> {
  if (activeOperations.has(operation.id))
    throw new ApiError(
      409,
      "workspace_busy",
      "Branch promotion is already running; inspect it after the operation finishes.",
    );
  activeOperations.add(operation.id);
  try {
    const thread = getThread(deps.db, operation.threadId);
    if (!thread || !ownsBranchPromotionClaim(deps.db, operation))
      throw new Error("Branch promotion no longer owns this checkout.");
    await ensureHostSessionReadyForWork(deps, { hostId: operation.hostId });
    const host = getNonDestroyedHostWithStatus(deps, operation.hostId);
    const record = getEnvironmentProvider("project-checkout");
    if (!host || !record)
      throw new Error("Project checkout provider or host is unavailable.");
    if (request.action === "enter")
      markBranchPromotionRunning(deps.db, operation.id);
    const invocation = await invokeEnvironmentProvider(
      record,
      "branch promotion",
      () =>
        record.provider.create({
          thread: toThreadResponseFromThread(deps, { thread }),
          project: requirePublicProject(deps.db, thread.projectId),
          host,
          projectCheckout: {
            path: operation.path,
            experimental_ownsPath: false,
          },
          gitRemote: null,
          inputs: { promotion: request },
          suggestedBranchName: operation.intent.target.name,
          attempt: 0,
          pathKey: operation.id,
          rebuild: false,
          previous: null,
          experimental_claimPath: async (path) =>
            path === operation.path &&
            ownsBranchPromotionClaim(deps.db, operation),
          report: {
            step: (step) =>
              deps.logger.debug(
                { operationId: operation.id, step },
                "Branch promotion progress",
              ),
            log: (log) =>
              deps.logger.debug(
                { operationId: operation.id, log },
                "Branch promotion output",
              ),
          },
          signal,
        }),
    );
    if (!invocation.ok) throw new Error(invocation.error);
    const result = providerResultSchema.parse(invocation.value);
    if (result.status === "failed") throw new Error(result.message);
    if (result.path !== operation.path)
      throw new Error("Branch promotion returned a different checkout path.");
    let defaultBranch: string | null | undefined;
    if (
      result.resource.commandTerminated &&
      ["completed", "failed", "resolved"].includes(result.resource.phase)
    ) {
      const metadata = await callHostRetryableOnlineRpc(deps, {
        hostId: operation.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.inspect_git_source",
          path: operation.path,
          remoteRefresh: "background",
        },
      });
      const currentBranch =
        metadata.checkout.kind === "branch" ||
        metadata.checkout.kind === "unborn"
          ? metadata.checkout.branchName
          : null;
      const currentHead =
        metadata.checkout.kind === "branch" ||
        metadata.checkout.kind === "detached"
          ? metadata.checkout.headSha
          : null;
      if (
        currentBranch !== result.resource.branchName ||
        currentHead !== result.resource.headSha
      )
        throw new Error(
          "Checkout changed during settlement; inspect again before continuing.",
        );
      defaultBranch = metadata.defaultBranch;
    }
    return recordBranchPromotionSnapshot(
      deps.db,
      deps.hub,
      operation,
      result.resource,
      defaultBranch,
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      409,
      "workspace_busy",
      `${promotionError(error)} The checkout remains reserved; inspect branch promotion again when its host is available.`,
    );
  } finally {
    activeOperations.delete(operation.id);
  }
}

function promotionResponse(
  operation: BranchPromotionRow,
  recovered = false,
): ToolCallResponse {
  const snapshot = operation.snapshot;
  if (operation.phase !== "completed" || !snapshot)
    return toolCallFailure(
      `${snapshot?.message ?? "Branch promotion has an uncertain outcome."} Do not edit. Inspect with bb thread promotion inspect ${operation.threadId} and resolve the reported state.`,
    );
  const reread =
    recovered ||
    operation.intent.target.kind === "existing" ||
    snapshot.replayed;
  return toolCallSuccess(
    `Using branch ${snapshot.branchName} in ${operation.path}. The environment and directory are unchanged; continue this turn. ${reread ? "Re-read relevant files before editing because their contents may have changed." : "The new branch was created from the verified current HEAD; project files are unchanged."}`,
  );
}

export async function handleEnterBranchToolCall(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    thread: Thread;
    currentEnvironment: EnvironmentRow;
    input: unknown;
    signal: AbortSignal;
  },
): Promise<ToolCallResponse> {
  const parsed = enterBranchInputSchema.safeParse(args.input ?? {});
  if (!parsed.success)
    return toolCallFailure(
      "Provide an empty object or a valid existing local branch name in branch.",
    );
  try {
    const thread = getThread(deps.db, args.thread.id);
    if (!thread) throw new Error("Thread no longer exists.");
    const writableFailure = threadWritableFailure(thread);
    if (writableFailure) throw new Error(writableFailure);
    if (thread.promotionTarget !== "branch")
      throw new Error("This thread did not select branch promotion.");
    const existing = getThreadBranchPromotion(deps.db, thread.id);
    if (
      existing &&
      (existing.settledAt === null || thread.worktreePromotion === "promoted")
    ) {
      if (
        (parsed.data.branch === undefined &&
          existing.intent.target.kind !== "new") ||
        (parsed.data.branch !== undefined &&
          (existing.intent.target.kind !== "existing" ||
            parsed.data.branch !== existing.intent.target.name))
      )
        throw new Error(
          "This operation already selected a different branch; inspect and resolve it first.",
        );
      if (existing.settledAt !== null) return promotionResponse(existing, true);
      return promotionResponse(
        await invokeBranchOperation(
          deps,
          existing,
          { action: "inspect", intent: existing.intent },
          args.signal,
        ),
      );
    }
    if (thread.worktreePromotion !== "armed")
      throw new Error("Branch promotion is no longer armed for this thread.");
    const environment =
      thread.environmentId === null
        ? null
        : getEnvironment(deps.db, thread.environmentId);
    const project = getProject(deps.db, thread.projectId);
    if (!project || project.deletedAt !== null || project.kind !== "standard")
      throw new Error("Branch promotion requires a live standard project.");
    if (
      !environment ||
      environment.id !== args.currentEnvironment.id ||
      !environment.path ||
      environment.status !== "ready" ||
      environment.isWorktree ||
      !environment.isGitRepo ||
      environment.environmentProviderId !== "project-checkout"
    )
      throw new Error(
        "Branch promotion requires a ready project checkout, outside a worktree.",
      );
    if (!getEnvironmentProvider("project-checkout"))
      throw new Error(
        "Project checkout provider is unavailable. Enable it before promoting.",
      );
    await ensureHostSessionReadyForWork(deps, { hostId: environment.hostId });
    const inspection = await callHostRetryableOnlineRpc(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.inspect_git_source",
        path: environment.path,
        remoteRefresh: "background",
      },
    });
    const checkout = inspection.checkout;
    if (checkout.kind !== "branch" || !checkout.headSha)
      throw new Error(
        "Branch promotion requires an existing branch with a commit, not detached or unborn HEAD.",
      );
    const operation = reserveBranchPromotion(deps.db, {
      threadId: thread.id,
      environmentId: environment.id,
      hostId: environment.hostId,
      intent: {
        operationId: randomUUID(),
        path: environment.path,
        sourceBranch: checkout.branchName,
        sourceHead: checkout.headSha,
        target:
          parsed.data.branch === undefined
            ? {
                kind: "new",
                name: buildSuggestedBranchName({
                  branchPrefix: getAppSettings(deps.db).managedBranchPrefix,
                  title: thread.title ?? thread.titleFallback,
                  threadId: thread.id,
                }),
              }
            : { kind: "existing", name: parsed.data.branch },
      },
    });
    return promotionResponse(
      await invokeBranchOperation(
        deps,
        operation,
        { action: "enter", intent: operation.intent },
        args.signal,
      ),
    );
  } catch (error) {
    return toolCallFailure(
      `${promotionError(error)} Do not edit until this is resolved. If an operation is pending, use bb thread promotion inspect ${args.thread.id}.`,
    );
  }
}

export async function inspectThreadBranchPromotion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  signal: AbortSignal,
) {
  const operation = getThreadBranchPromotion(deps.db, threadId);
  if (!operation) return null;
  const updated =
    operation.settledAt === null
      ? await invokeBranchOperation(
          deps,
          operation,
          { action: "inspect", intent: operation.intent },
          signal,
        )
      : operation;
  return {
    operationId: updated.id,
    phase: updated.phase,
    intent: updated.intent,
    snapshot: updated.snapshot,
  };
}

export async function resolveThreadBranchPromotion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    threadId: string;
    operationId: string;
    observation: string;
    resolution: "accept-current" | "keep-current";
  },
  signal: AbortSignal,
) {
  const operation = getThreadBranchPromotion(deps.db, args.threadId);
  if (!operation || operation.id !== args.operationId)
    throw new ApiError(
      409,
      "invalid_request",
      "Branch promotion operation changed; inspect it again.",
    );
  if (operation.settledAt !== null) {
    if (operation.snapshot?.resolution !== args.resolution)
      throw new ApiError(
        409,
        "invalid_request",
        "Branch promotion was already settled with another outcome.",
      );
  } else {
    const updated = await invokeBranchOperation(
      deps,
      operation,
      {
        action: "resolve",
        intent: operation.intent,
        observation: args.observation,
        resolution: args.resolution,
      },
      signal,
    );
    if (updated.settledAt === null)
      throw new ApiError(
        409,
        "invalid_request",
        updated.snapshot?.message ??
          "Branch promotion remains unresolved; inspect again before resolving.",
      );
  }
  return inspectThreadBranchPromotion(deps, args.threadId, signal);
}

export async function reconcileBranchPromotions(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  for (const operation of listUnsettledBranchPromotions(deps.db)) {
    if (activeOperations.has(operation.id)) continue;
    try {
      await invokeBranchOperation(
        deps,
        operation,
        { action: "inspect", intent: operation.intent },
        AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      );
    } catch (error) {
      deps.logger.debug(
        { operationId: operation.id, error: promotionError(error) },
        "Branch promotion reconciliation awaits its host",
      );
    }
  }
}

export async function validateBranchPromotionPlacement(
  deps: WorkSessionDeps,
  environment: ResolvedCreateThreadEnvironment,
  requested: CreateThreadEnvironmentArgs,
): Promise<void> {
  if (requested.type !== "project-default" || requested.promotion !== "branch")
    return;
  if (
    environment.type !== "provider" ||
    environment.environmentProviderId !== "project-checkout" ||
    environment.machine?.type !== "existing"
  )
    throw new ApiError(
      409,
      "invalid_request",
      "Branch promotion requires an available project checkout.",
    );
  const inputs = z
    .object({ path: z.string().min(1) })
    .parse(environment.inputs);
  const inspection = await callHostRetryableOnlineRpc(deps, {
    hostId: environment.machine.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.inspect_git_source",
      path: inputs.path,
      remoteRefresh: "background",
    },
  });
  if (
    inspection.isWorktree ||
    inspection.checkout.kind !== "branch" ||
    !inspection.checkout.headSha
  )
    throw new ApiError(
      409,
      "invalid_request",
      "Checkout, then branch requires a Git checkout on a branch with a commit, outside a worktree.",
    );
}
