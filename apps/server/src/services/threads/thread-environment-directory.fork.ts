import { z } from "zod";
import type { GitSourceInspection, JsonValue } from "@bb/domain";
import {
  createEnvironment,
  createEnvironmentId,
  type EnvironmentRow,
  getEnvironment,
  getAppSettings,
  getProject,
  getThread,
  getActiveBranchPromotion,
  projectSourceOwnsPath,
  updateThread,
} from "@bb/db";
import type { DynamicTool, Thread, ToolCallResponse } from "@bb/domain";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { AppDeps } from "../../types.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../environments/environment-provider-ids.js";
import { ENVIRONMENT_HOOK_TIMEOUT_MS } from "../environments/environment-hooks.js";
import {
  requestEnvironmentRemoval,
  sweepProviderEnvironment,
} from "../environments/environment-engine.js";
import {
  getEnvironmentProvider,
  invokeEnvironmentProvider,
  type PluginEnvironmentProviderRecord,
} from "../plugins/plugin-environment-provider-registry.js";
import {
  buildEnvironmentProvisionCommand,
  buildSuggestedBranchName,
} from "./thread-create-helpers.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  getNonDestroyedHostWithStatus,
  findHostDataDir,
  requirePublicProject,
} from "../lib/entity-lookup.js";
import { toThreadResponseFromThread } from "./thread-runtime-display.js";
import { worktreeProviderInputs } from "./thread-environment-placement.js";
import { suppliedWorkspacePathRefusal } from "./workspace-path-claims.js";

import {
  attachReadyEnvironment,
  resolveReadyEnvironment,
  threadWritableFailure,
  toolCallFailure,
  toolCallSuccess,
  type AttachEnvironmentResult,
  type ReadyEnvironment,
} from "./thread-environment-directory.js";

interface HandleEnterWorktreeToolCallArgs {
  currentEnvironment: EnvironmentRow;
  input: unknown;
  thread: Thread;
  turnId: string;
}

export const ENTER_WORKTREE_TOOL_NAME = "bb_enter_worktree";

const ENTER_WORKTREE_TIMEOUT_MS = 15 * 60 * 1000;

const enterWorktreeInputSchema = z.object({}).strict();

export const ENTER_WORKTREE_TOOL: DynamicTool = {
  name: ENTER_WORKTREE_TOOL_NAME,
  description:
    "Create a BB-managed Git worktree for this thread and move future turns into it. Keep read-only exploration in the current checkout so repository-local indexes remain available, then call this immediately before editing files or running commands that may modify the project unless the user explicitly asked to keep changes in the current checkout. Do not ask the user to create or enter the worktree. After a successful switch, stop the current turn because the running provider cwd will not change until the next turn.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  presentation: {
    label: {
      pending: "Entering an isolated worktree",
      completed: "Prepared an isolated worktree",
    },
    icon: { glyph: "GitBranch" },
  },
};

export const KEEP_CHECKOUT_TOOL_NAME = "bb_keep_checkout";

const keepCheckoutInputSchema = z.object({}).strict();

export const KEEP_CHECKOUT_TOOL: DynamicTool = {
  name: KEEP_CHECKOUT_TOOL_NAME,
  description:
    "Record the user's explicit decision to skip the selected promotion. For worktree mode, call when the user asks to stay in the checkout or skip the worktree. For branch mode, call only when the user asks to keep the current branch or skip branching; staying in the checkout alone does not decline branching. The decision persists for the rest of the thread, so bb stops instructing you to promote on later turns. Work continues in the current directory; this tool does not end the turn.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  presentation: {
    label: {
      pending: "Staying in the project checkout",
      completed: "Staying in the project checkout",
    },
    icon: { glyph: "Laptop" },
  },
};

interface WorktreeCheckoutBase {
  branchName: string;
  headSha: string;
}

function enterWorktreeSuccessMessage(path: string): string {
  return `Prepared BB-managed worktree at ${path} and queued continuation there. Stop work in this turn; the next turn will continue automatically in the isolated worktree.`;
}

function enterWorktreePreflightResponse(
  deps: AppDeps,
  args: HandleEnterWorktreeToolCallArgs,
): ToolCallResponse | null {
  if (!enterWorktreeInputSchema.safeParse(args.input ?? {}).success) {
    return toolCallFailure("Invalid arguments. Provide an empty object.");
  }
  const writableFailure = threadWritableFailure(args.thread);
  if (writableFailure) return toolCallFailure(writableFailure);
  if (args.thread.promotionTarget !== "worktree")
    return toolCallFailure(
      "This thread selected branch promotion, not worktree promotion.",
    );
  if (args.thread.worktreePromotion !== "armed") {
    return toolCallFailure(
      "Worktree promotion was declined for this thread, so bb_enter_worktree is no longer available.",
    );
  }
  const project = getProject(deps.db, args.thread.projectId);
  if (!project || project.deletedAt !== null) {
    return toolCallFailure("Project no longer exists.");
  }
  if (project.kind !== "standard") {
    return toolCallFailure(
      "Managed worktree promotion is only available for standard projects.",
    );
  }
  if (!args.currentEnvironment.isGitRepo) {
    return toolCallFailure(
      "Managed worktree promotion requires a Git repository.",
    );
  }
  if (args.currentEnvironment.isWorktree) {
    return toolCallSuccess(
      `This thread is already using the worktree at ${args.currentEnvironment.path}.`,
    );
  }
  return null;
}

async function inspectWorktreeSource(
  deps: AppDeps,
  args: { hostId: string; sourcePath: string },
): Promise<
  { dataDir: string; checkout: GitSourceInspection } | ToolCallResponse
> {
  try {
    const dataDir = (
      await ensureHostSessionReadyForWork(deps, { hostId: args.hostId })
    ).dataDir;
    const checkout = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.inspect_git_source",
        path: args.sourcePath,
        remoteRefresh: "background",
      },
    });
    return { dataDir, checkout };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolCallFailure(`Could not create an isolated worktree: ${message}`);
  }
}

function resolveWorktreeCheckoutBase(
  checkout: GitSourceInspection,
): WorktreeCheckoutBase | ToolCallResponse {
  if (checkout.checkout.kind === "unborn") {
    return toolCallFailure(
      "The current checkout has no commits, so Git cannot create a worktree yet. Continue in the current checkout to create the initial commit.",
    );
  }
  if (checkout.checkout.kind === "detached") {
    return toolCallFailure(
      "The current checkout has a detached HEAD. Switch it to a branch before creating an isolated worktree.",
    );
  }
  if (checkout.checkout.kind === "unknown") {
    return toolCallFailure(
      `Could not create an isolated worktree: ${checkout.checkout.reason}`,
    );
  }
  if (!checkout.checkout.headSha) {
    return toolCallFailure(
      "The current branch has no commit to use as the worktree base. Continue in the current checkout to create the initial commit.",
    );
  }
  if (checkout.hasUncommittedChanges) {
    return toolCallFailure(
      `The current checkout has uncommitted changes that cannot be transferred safely. Run \`git stash push --include-untracked\` in the checkout, call ${ENTER_WORKTREE_TOOL_NAME} again, and run \`git stash pop\` in the prepared worktree on the next turn; the worktree starts from the same commit, so the stash applies there. Commit the changes instead when they belong on the current branch, or continue in the current checkout if the user asked for that.`,
    );
  }
  if (checkout.operation.kind !== "none") {
    return toolCallFailure(
      `The current checkout has a ${checkout.operation.kind} operation in progress. Finish or abort it before creating an isolated worktree.`,
    );
  }
  return {
    branchName: checkout.checkout.branchName,
    headSha: checkout.checkout.headSha,
  };
}

const worktreeCreateResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("created"),
    path: z.string().min(1),
    ownsPath: z.boolean().default(false),
    mergeBaseBranch: z.string().min(1).optional(),
    resource: z.unknown().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    failure: z.enum(["terminal", "transient"]),
    message: z.string().min(1),
  }),
]);

interface CreateWorktreeResourceArgs {
  currentEnvironment: EnvironmentRow;
  inputs: JsonValue;
  instanceKey: string;
  record: PluginEnvironmentProviderRecord;
  sourcePath: string;
  thread: Thread;
}

async function createWorktreeResource(
  deps: AppDeps,
  args: CreateWorktreeResourceArgs,
): Promise<{ path: string; mergeBaseBranch?: string } | ToolCallResponse> {
  const host = getNonDestroyedHostWithStatus(
    deps,
    args.currentEnvironment.hostId,
  );
  if (host === null) {
    return toolCallFailure(
      "Could not create an isolated worktree: the current machine no longer exists.",
    );
  }
  const thread = getThread(deps.db, args.thread.id);
  if (!thread) {
    return toolCallFailure("Thread no longer exists.");
  }
  const controller = new AbortController();
  const invocation = await invokeEnvironmentProvider(
    args.record,
    "environment create",
    () =>
      args.record.provider.create({
        thread: toThreadResponseFromThread(deps, { thread }),
        project: requirePublicProject(deps.db, args.thread.projectId),
        host,
        projectCheckout: {
          path: args.sourcePath,
          experimental_ownsPath: projectSourceOwnsPath(
            deps.db,
            args.thread.projectId,
            host.id,
            args.sourcePath,
          ),
        },
        gitRemote: null,
        inputs: args.inputs,
        suggestedBranchName: buildSuggestedBranchName({
          branchPrefix: getAppSettings(deps.db).managedBranchPrefix,
          title: args.thread.title ?? args.thread.titleFallback,
          threadId: args.thread.id,
        }),
        pathKey: args.instanceKey,
        attempt: 0,
        rebuild: false,
        experimental_claimPath: async () => true,
        previous: null,
        report: { step: () => undefined, log: () => undefined },
        signal: controller.signal,
      }),
  );
  if (!invocation.ok) {
    return toolCallFailure(
      `Could not create an isolated worktree: ${invocation.error}`,
    );
  }
  if (invocation.value === null) {
    return toolCallFailure(
      "Could not create an isolated worktree: the environment provider became unavailable.",
    );
  }
  const result = worktreeCreateResultSchema.parse(invocation.value);
  if (result.status === "failed") {
    return toolCallFailure(
      `Could not create an isolated worktree: ${result.message}`,
    );
  }
  return {
    path: result.path.replace(/\/+$/u, "") || "/",
    ...(result.mergeBaseBranch === undefined
      ? {}
      : { mergeBaseBranch: result.mergeBaseBranch }),
  };
}

interface PersistWorktreeEnvironmentArgs {
  created: { path: string; mergeBaseBranch?: string };
  currentEnvironment: EnvironmentRow;
  inputs: JsonValue;
  instanceKey: string;
  record: PluginEnvironmentProviderRecord;
  thread: Thread;
}

async function persistWorktreeEnvironment(
  deps: AppDeps,
  args: PersistWorktreeEnvironmentArgs,
): Promise<ReadyEnvironment | ToolCallResponse> {
  const dataDir = findHostDataDir(deps, args.currentEnvironment.hostId);
  const refusal = suppliedWorkspacePathRefusal(deps.db, {
    dataDir,
    hostId: args.currentEnvironment.hostId,
    path: args.created.path,
    projectId: args.thread.projectId,
  });
  if (refusal !== null) {
    await removeWorktreeResource(deps, {
      hostId: args.currentEnvironment.hostId,
      instanceKey: args.instanceKey,
      path: args.created.path,
      record: args.record,
    });
    return toolCallFailure(`Could not create an isolated worktree: ${refusal}`);
  }
  const environment = createEnvironment(deps.db, deps.hub, {
    projectId: args.thread.projectId,
    hostId: args.currentEnvironment.hostId,
    path: args.created.path,
    providerOwnsPath: true,
    status: "provisioning",
    ...(args.created.mergeBaseBranch === undefined
      ? {}
      : { mergeBaseBranch: args.created.mergeBaseBranch }),
    environmentProvider: {
      environmentProviderId: DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
      pluginId: args.record.pluginId,
      instanceKey: args.instanceKey,
      selection: {
        machine: { type: "existing", hostId: args.currentEnvironment.hostId },
        inputs: args.inputs,
      },
    },
  });
  const command = buildEnvironmentProvisionCommand({
    environmentId: environment.id,
    hostId: args.currentEnvironment.hostId,
    initiator: null,
    path: args.created.path,
    setupScriptTimeoutMs: ENVIRONMENT_HOOK_TIMEOUT_MS,
  });

  try {
    await runLiveHostCommand(deps, {
      hostId: args.currentEnvironment.hostId,
      command,
      timeoutMs: ENTER_WORKTREE_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reclaimWorktreeEnvironment(deps, environment.id);
    return toolCallFailure(`Could not create an isolated worktree: ${message}`);
  }

  const readyEnvironment = getEnvironment(deps.db, environment.id);
  if (!readyEnvironment) {
    return toolCallFailure("Prepared worktree environment no longer exists.");
  }
  const ready = resolveReadyEnvironment(readyEnvironment);
  if ("failure" in ready) {
    await reclaimWorktreeEnvironment(deps, environment.id);
    return toolCallFailure(ready.failure);
  }
  return ready;
}

async function removeWorktreeResource(
  deps: AppDeps,
  args: {
    hostId: string;
    instanceKey: string;
    path: string;
    record: PluginEnvironmentProviderRecord;
  },
): Promise<void> {
  const controller = new AbortController();
  try {
    const invocation = await invokeEnvironmentProvider(
      args.record,
      "environment remove",
      () =>
        args.record.provider.remove({
          environment: null,
          hostId: args.hostId,
          path: args.path,
          pathKey: args.instanceKey,
          resource: null,
          attempt: 0,
          report: { step: () => undefined, log: () => undefined },
          signal: controller.signal,
        }),
    );
    if (!invocation.ok) {
      deps.logger.warn(
        { error: invocation.error, path: args.path },
        "Worktree promotion could not reclaim an unattached worktree",
      );
    }
  } catch (error) {
    deps.logger.warn(
      { err: error, path: args.path },
      "Worktree promotion could not reclaim an unattached worktree",
    );
  }
}

async function reclaimWorktreeEnvironment(
  deps: AppDeps,
  environmentId: string,
): Promise<void> {
  requestEnvironmentRemoval(deps, environmentId);
  try {
    await sweepProviderEnvironment(deps, environmentId);
  } catch (error) {
    deps.logger.warn(
      { err: error, environmentId },
      "Worktree promotion cleanup failed",
    );
  }
}

async function provisionWorktreeEnvironment(
  deps: AppDeps,
  args: HandleEnterWorktreeToolCallArgs,
): Promise<ReadyEnvironment | ToolCallResponse> {
  const sourcePath = args.currentEnvironment.path;
  if (!sourcePath) {
    return toolCallFailure(
      "Could not create an isolated worktree: the current environment has no directory.",
    );
  }
  const record = getEnvironmentProvider(
    DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree,
  );
  if (record === undefined) {
    return toolCallFailure(
      `Could not create an isolated worktree: the "${DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree}" environment provider is not registered by any running plugin.`,
    );
  }
  const inspection = await inspectWorktreeSource(deps, {
    hostId: args.currentEnvironment.hostId,
    sourcePath,
  });
  if ("success" in inspection) return inspection;
  const checkoutBase = resolveWorktreeCheckoutBase(inspection.checkout);
  if ("success" in checkoutBase) return checkoutBase;

  const instanceKey = createEnvironmentId();
  const inputs = worktreeProviderInputs({
    kind: "named",
    name: checkoutBase.headSha,
  });
  const created = await createWorktreeResource(deps, {
    currentEnvironment: args.currentEnvironment,
    inputs,
    instanceKey,
    record,
    sourcePath,
    thread: args.thread,
  });
  if ("success" in created) return created;

  return persistWorktreeEnvironment(deps, {
    created,
    currentEnvironment: args.currentEnvironment,
    inputs,
    instanceKey,
    record,
    thread: args.thread,
  });
}

async function attachProvisionedWorktree(
  deps: AppDeps,
  args: HandleEnterWorktreeToolCallArgs,
  targetEnvironment: ReadyEnvironment,
): Promise<AttachEnvironmentResult> {
  try {
    const continuationExecution = await buildExecutionOptions(
      deps,
      {},
      { threadId: args.thread.id },
    );
    const result = attachReadyEnvironment(deps, {
      currentEnvironment: args.currentEnvironment,
      createdEnvironment: true,
      targetEnvironment,
      thread: args.thread,
      turnId: args.turnId,
      continuationExecution,
      requiresArmedPromotion: true,
    });
    if (result.kind !== "attached") {
      await reclaimWorktreeEnvironment(deps, targetEnvironment.id);
    }
    return result;
  } catch (error) {
    if (
      getThread(deps.db, args.thread.id)?.environmentId !== targetEnvironment.id
    ) {
      await reclaimWorktreeEnvironment(deps, targetEnvironment.id);
    }
    throw error;
  }
}

interface HandleKeepCheckoutToolCallArgs {
  currentEnvironment: EnvironmentRow;
  input: unknown;
  thread: Thread;
}

export function handleKeepCheckoutToolCall(
  deps: AppDeps,
  args: HandleKeepCheckoutToolCallArgs,
): ToolCallResponse {
  if (!keepCheckoutInputSchema.safeParse(args.input ?? {}).success) {
    return toolCallFailure("Invalid arguments. Provide an empty object.");
  }
  return deps.db.transaction(
    (tx) => {
      const latestThread = getThread(tx, args.thread.id);
      if (latestThread === null) {
        return toolCallFailure("Thread no longer exists.");
      }
      const writableFailure = threadWritableFailure(latestThread);
      if (writableFailure) return toolCallFailure(writableFailure);
      if (getActiveBranchPromotion(tx, latestThread.id))
        return toolCallFailure(
          "Branch promotion is pending. Inspect and resolve it before declining.",
        );
      if (latestThread.worktreePromotion === "promoted")
        return toolCallFailure(
          "Promotion already completed; its recorded result cannot be declined.",
        );
      if (latestThread.worktreePromotion === "declined")
        return toolCallSuccess(
          "This thread already stays in its current checkout.",
        );
      const latestEnvironment =
        latestThread.environmentId === null
          ? null
          : getEnvironment(tx, latestThread.environmentId);
      if (latestEnvironment === null) {
        return toolCallFailure("Thread environment no longer exists.");
      }
      if (
        latestEnvironment.isWorktree ||
        latestEnvironment.environmentProviderId ===
          DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree
      ) {
        return toolCallFailure(
          `This thread already runs in the worktree at ${latestEnvironment.path}. Declining promotion would not move it back; use update_environment_directory if the user wants a different directory.`,
        );
      }
      const updated = updateThread(tx, deps.hub, latestThread.id, {
        worktreePromotion: "declined",
      });
      if (updated === null) {
        return toolCallFailure("Thread no longer exists.");
      }
      return toolCallSuccess(
        `Recorded that this thread stays in ${latestEnvironment.path ?? "the project checkout"}. bb will not ask you to promote this checkout again in this thread. Continue working in the current directory.`,
      );
    },
    { behavior: "immediate" },
  );
}

export async function handleEnterWorktreeToolCall(
  deps: AppDeps,
  args: HandleEnterWorktreeToolCallArgs,
): Promise<ToolCallResponse> {
  const preflightResponse = enterWorktreePreflightResponse(deps, args);
  if (preflightResponse) return preflightResponse;

  const provisionedEnvironment = await provisionWorktreeEnvironment(deps, args);
  if ("success" in provisionedEnvironment) {
    return provisionedEnvironment;
  }
  const attachResult = await attachProvisionedWorktree(
    deps,
    args,
    provisionedEnvironment,
  );

  switch (attachResult.kind) {
    case "attached":
      return toolCallSuccess(
        enterWorktreeSuccessMessage(provisionedEnvironment.path),
      );
    case "environment_changed":
      return toolCallFailure(
        "Thread environment changed while preparing the worktree. Continue from the thread's current environment.",
      );
    case "promotion_declined":
      return toolCallFailure(
        "Worktree promotion was declined while preparing the worktree. Continue from the current checkout.",
      );
    case "thread_unavailable":
      return toolCallFailure(attachResult.message);
  }
}
