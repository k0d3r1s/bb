import { assertEnvironmentPathAvailable } from "../environments/path-admission.js";
import { z } from "zod";
import {
  createEnvironment,
  createEnvironmentId,
  createQueuedThreadMessageInTransaction,
  type DbTransaction,
  type EnvironmentRow,
  createEventId,
  findProjectEnvironmentByHostPath,
  getEnvironment,
  getAppSettings,
  getProject,
  getThread,
  listQueuedThreadMessages,
  projectSourceOwnsPath,
  updateThread,
} from "@bb/db";
import { turnScope } from "@bb/domain";
import type { JsonValue } from "@bb/domain";
import type {
  DynamicTool,
  ResolvedThreadExecutionOptions,
  Thread,
  ToolCallResponse,
} from "@bb/domain";
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
import { appendThreadEventInTransaction } from "./thread-events.js";
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
import { foreignProviderOwnedPathRefusal } from "./workspace-path-claims.js";
import {
  ENTER_WORKTREE_CONTINUATION_TEXT,
  isEnterWorktreeContinuationContent,
  isSupersedingUserQueueEnvelope,
} from "./worktree-promotion.js";

export const UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME =
  "update_environment_directory";

const UPDATE_ENVIRONMENT_DIRECTORY_TIMEOUT_MS = 5 * 60 * 1000;

const updateEnvironmentDirectoryInputSchema = z
  .object({
    path: z.string().trim().min(1),
  })
  .strict();

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
    "Record that this thread stays in the project's existing checkout instead of moving to a BB-managed worktree. Call this when the user asks to work in the current checkout, to skip the worktree, or declines one you offered. The decision persists for the rest of the thread, so bb stops instructing you to promote on later turns. Work continues in the current directory; this tool does not end the turn.",
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

export const UPDATE_ENVIRONMENT_DIRECTORY_TOOL: DynamicTool = {
  name: UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
  description:
    "Move this bb thread to a different working directory for subsequent turns. Use this when the user asks to switch to a new checkout, worktree, or local directory. The path must be an absolute existing directory on the current host. The tool reuses this project's existing bb environment for that host/path, otherwise it creates an unmanaged environment after validating the path. Another project may hold its own environment for the same directory; that is allowed, except for a bb-managed worktree owned by another project, which this tool refuses. After a successful switch, stop the current turn because the running provider cwd will not change until the next turn.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path to an existing directory on the current host.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  presentation: {
    label: {
      pending: "Moving the thread directory",
      completed: "Moved the thread directory",
    },
    icon: { glyph: "FolderOpen" },
  },
};

interface HandleUpdateEnvironmentDirectoryToolCallArgs {
  currentEnvironment: EnvironmentRow;
  input: unknown;
  thread: Thread;
  turnId: string;
}

type ReadyEnvironment = EnvironmentRow & { path: string; status: "ready" };

type AttachEnvironmentResult =
  | { kind: "attached"; changed: boolean; queuedContinuation: boolean }
  | { kind: "environment_changed" }
  | { kind: "promotion_declined" }
  | { kind: "thread_unavailable"; message: string };

interface AttachReadyEnvironmentArgs {
  currentEnvironment: EnvironmentRow;
  createdEnvironment: boolean;
  targetEnvironment: ReadyEnvironment;
  thread: Thread;
  turnId: string;
  continuationExecution?: ResolvedThreadExecutionOptions;
  requiresArmedPromotion?: boolean;
}

function toolCallTextResponse(
  success: boolean,
  text: string,
): ToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

function toolCallFailure(text: string): ToolCallResponse {
  return toolCallTextResponse(false, text);
}

function toolCallSuccess(text: string): ToolCallResponse {
  return toolCallTextResponse(true, text);
}

function normalizeDirectoryPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/") {
    return trimmed;
  }
  return trimmed.replace(/\/+$/u, "");
}

function validateDirectoryPath(path: string): string | null {
  if (!path.startsWith("/")) {
    return "Path must be an absolute path on the current host.";
  }
  if (path === "/") {
    return "Path must name a project directory, not the filesystem root.";
  }
  if (path.includes("\0")) {
    return "Path must not contain NUL bytes.";
  }
  return null;
}

function threadWritableFailure(thread: Thread): string | null {
  if (thread.deletedAt !== null) {
    return "Cannot update the environment directory for a deleted thread.";
  }
  if (thread.archivedAt !== null) {
    return "Cannot update the environment directory for an archived thread.";
  }
  return null;
}

function resolveReadyEnvironment(
  environment: EnvironmentRow,
): ReadyEnvironment | { failure: string } {
  if (environment.status !== "ready") {
    return {
      failure: `Environment at this path is ${environment.status}, not ready.`,
    };
  }
  if (!environment.path) {
    return {
      failure: "Environment at this path does not have a resolved directory.",
    };
  }
  return {
    ...environment,
    path: environment.path,
    status: environment.status,
  };
}

function successMessage(path: string): string {
  return `Environment directory updated to ${path}. This applies to future turns; stop work in this turn so the next turn can run from the updated directory.`;
}

function appendEnvironmentAttachmentEvent(
  tx: DbTransaction,
  args: AttachReadyEnvironmentArgs,
  threadId: string,
): void {
  appendThreadEventInTransaction(tx, {
    threadId,
    environmentId: args.targetEnvironment.id,
    type: "system/operation",
    scope: turnScope(args.turnId),
    data: {
      operation: "environment_directory_update",
      operationId: createEventId(),
      status: "completed",
      message: `Updated environment directory to ${args.targetEnvironment.path}`,
      metadata: {
        createdEnvironment: args.createdEnvironment,
        previousEnvironmentId: args.currentEnvironment.id,
        previousPath: args.currentEnvironment.path,
        nextEnvironmentId: args.targetEnvironment.id,
        nextPath: args.targetEnvironment.path,
      },
    },
  });
}

function queueEnterWorktreeContinuation(
  tx: DbTransaction,
  args: AttachReadyEnvironmentArgs,
  threadId: string,
): boolean {
  const execution = args.continuationExecution;
  if (!execution) return false;
  const hasSupersedingMessage = listQueuedThreadMessages(tx, threadId).some(
    (queuedMessage) =>
      isSupersedingUserQueueEnvelope(queuedMessage) &&
      !isEnterWorktreeContinuationContent(queuedMessage.content),
  );
  if (hasSupersedingMessage) return false;
  createQueuedThreadMessageInTransaction(tx, {
    threadId,
    content: [
      {
        type: "text",
        text: ENTER_WORKTREE_CONTINUATION_TEXT,
        mentions: [],
        visibility: "agent-only",
      },
    ],
    senderThreadId: null,
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    permissionMode: execution.permissionMode,
    serviceTier: execution.serviceTier,
    waitingOn: { kind: "thread-busy" },
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
  });
  return true;
}

function attachReadyEnvironmentInTransaction(
  tx: DbTransaction,
  hub: AppDeps["hub"],
  args: AttachReadyEnvironmentArgs,
): AttachEnvironmentResult {
  const latestThread = getThread(tx, args.thread.id);
  if (!latestThread || latestThread.deletedAt !== null) {
    return { kind: "thread_unavailable", message: "Thread no longer exists." };
  }

  const writableFailure = threadWritableFailure(latestThread);
  if (writableFailure) {
    return { kind: "thread_unavailable", message: writableFailure };
  }

  if (
    args.requiresArmedPromotion === true &&
    latestThread.worktreePromotion !== "armed"
  ) {
    return { kind: "promotion_declined" };
  }

  if (latestThread.environmentId === args.targetEnvironment.id) {
    return { kind: "attached", changed: false, queuedContinuation: false };
  }

  if (latestThread.environmentId !== args.currentEnvironment.id) {
    return { kind: "environment_changed" };
  }

  updateThread(tx, hub, latestThread.id, {
    environmentId: args.targetEnvironment.id,
  });
  appendEnvironmentAttachmentEvent(tx, args, latestThread.id);
  const queuedContinuation = queueEnterWorktreeContinuation(
    tx,
    args,
    latestThread.id,
  );
  return { kind: "attached", changed: true, queuedContinuation };
}

function attachReadyEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AttachReadyEnvironmentArgs,
): AttachEnvironmentResult {
  const result = deps.db.transaction(
    (tx) => attachReadyEnvironmentInTransaction(tx, deps.hub, args),
    { behavior: "immediate" },
  );

  if (result.kind === "attached" && result.changed) {
    deps.hub.notifyThread(
      args.thread.id,
      result.queuedContinuation
        ? ["events-appended", "queue-changed"]
        : ["events-appended"],
      { eventTypes: ["system/operation"] },
    );
  }

  return result;
}

async function provisionUnmanagedEnvironmentForPath(
  deps: AppDeps,
  args: {
    currentEnvironment: EnvironmentRow;
    path: string;
    thread: Thread;
  },
): Promise<ReadyEnvironment | ToolCallResponse> {
  const environment = createEnvironment(deps.db, deps.hub, {
    projectId: args.thread.projectId,
    hostId: args.currentEnvironment.hostId,
    providerOwnsPath: false,
    status: "provisioning",
    environmentProvider: null,
  });
  const command = buildEnvironmentProvisionCommand({
    environmentId: environment.id,
    hostId: args.currentEnvironment.hostId,
    initiator: null,
    path: args.path,
    setupScriptTimeoutMs: null,
  });

  try {
    await runLiveHostCommand(deps, {
      hostId: args.currentEnvironment.hostId,
      command,
      timeoutMs: UPDATE_ENVIRONMENT_DIRECTORY_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolCallFailure(
      `Could not update environment directory to ${args.path}: ${message}`,
    );
  }

  const readyEnvironment = getEnvironment(deps.db, environment.id);
  if (!readyEnvironment) {
    return toolCallFailure("Prepared environment no longer exists.");
  }
  const ready = resolveReadyEnvironment(readyEnvironment);
  if ("failure" in ready) {
    return toolCallFailure(ready.failure);
  }
  return ready;
}

function confirmCurrentEnvironmentDirectory(
  deps: Pick<AppDeps, "db" | "hub">,
  args: HandleUpdateEnvironmentDirectoryToolCallArgs,
  normalizedPath: string,
): ToolCallResponse | null {
  return deps.db.transaction(
    (tx) => {
      const latestThread = getThread(tx, args.thread.id);
      if (latestThread === null) {
        return toolCallFailure("Thread no longer exists.");
      }
      const writableFailure = threadWritableFailure(latestThread);
      if (writableFailure) return toolCallFailure(writableFailure);
      const latestEnvironment =
        latestThread.environmentId === null
          ? null
          : getEnvironment(tx, latestThread.environmentId);
      if (latestEnvironment === null) {
        return toolCallFailure("Thread environment no longer exists.");
      }
      if (latestEnvironment.path !== normalizedPath) return null;
      if (
        !latestEnvironment.isWorktree &&
        latestEnvironment.environmentProviderId !==
          DEFAULT_ENVIRONMENT_PROVIDER_ID.gitWorktree
      ) {
        updateThread(tx, deps.hub, latestThread.id, {
          worktreePromotion: "declined",
        });
      }
      return toolCallSuccess(
        `This thread is already using ${normalizedPath} as its environment directory.`,
      );
    },
    { behavior: "immediate" },
  );
}

function environmentAttachmentResponse(
  deps: Pick<AppDeps, "db" | "hub">,
  args: HandleUpdateEnvironmentDirectoryToolCallArgs,
  targetEnvironment: ReadyEnvironment,
  attachResult: AttachEnvironmentResult,
): ToolCallResponse {
  switch (attachResult.kind) {
    case "attached":
      if (!targetEnvironment.isWorktree) {
        updateThread(deps.db, deps.hub, args.thread.id, {
          worktreePromotion: "declined",
        });
      }
      return toolCallSuccess(successMessage(targetEnvironment.path));
    case "environment_changed":
      return toolCallFailure(
        "Thread environment changed while preparing the new directory. Try again with the desired path.",
      );
    case "promotion_declined":
      return toolCallFailure(
        "Worktree promotion was declined while preparing the new directory. Continue from the current checkout.",
      );
    case "thread_unavailable":
      return toolCallFailure(attachResult.message);
  }
}

export async function handleUpdateEnvironmentDirectoryToolCall(
  deps: AppDeps,
  args: HandleUpdateEnvironmentDirectoryToolCallArgs,
): Promise<ToolCallResponse> {
  const input = updateEnvironmentDirectoryInputSchema.safeParse(args.input);
  if (!input.success) {
    return toolCallFailure(
      "Invalid arguments. Provide an object with an absolute path string.",
    );
  }

  const normalizedPath = normalizeDirectoryPath(input.data.path);
  const pathFailure = validateDirectoryPath(normalizedPath);
  if (pathFailure) {
    return toolCallFailure(pathFailure);
  }

  const writableFailure = threadWritableFailure(args.thread);
  if (writableFailure) {
    return toolCallFailure(writableFailure);
  }

  try {
    assertEnvironmentPathAvailable(deps, {
      hostId: args.currentEnvironment.hostId,
      path: normalizedPath,
      threadId: args.thread.id,
    });
  } catch (error) {
    return toolCallFailure(
      error instanceof Error ? error.message : String(error),
    );
  }

  const currentDirectoryResponse = confirmCurrentEnvironmentDirectory(
    deps,
    args,
    normalizedPath,
  );
  if (currentDirectoryResponse !== null) return currentDirectoryResponse;

  const existingEnvironment = findProjectEnvironmentByHostPath(
    deps.db,
    args.thread.projectId,
    args.currentEnvironment.hostId,
    normalizedPath,
  );
  let createdEnvironment = false;
  let targetEnvironment: ReadyEnvironment;

  if (existingEnvironment) {
    const ready = resolveReadyEnvironment(existingEnvironment);
    if ("failure" in ready) {
      return toolCallFailure(ready.failure);
    }
    targetEnvironment = ready;
  } else {
    const dataDir = findHostDataDir(deps, args.currentEnvironment.hostId);
    const refusal = foreignProviderOwnedPathRefusal(deps.db, {
      dataDir,
      hostId: args.currentEnvironment.hostId,
      path: normalizedPath,
      projectId: args.thread.projectId,
    });
    if (refusal !== null) {
      return toolCallFailure(`${refusal}. Use a different directory.`);
    }
    const provisionedEnvironment = await provisionUnmanagedEnvironmentForPath(
      deps,
      {
        currentEnvironment: args.currentEnvironment,
        path: normalizedPath,
        thread: args.thread,
      },
    );

    if ("success" in provisionedEnvironment) {
      return provisionedEnvironment;
    }
    targetEnvironment = provisionedEnvironment;
    createdEnvironment = true;
  }

  let attachResult: AttachEnvironmentResult;
  try {
    assertEnvironmentPathAvailable(deps, {
      ...targetEnvironment,
      threadId: args.thread.id,
    });
    attachResult = attachReadyEnvironment(deps, {
      currentEnvironment: args.currentEnvironment,
      createdEnvironment,
      targetEnvironment,
      thread: args.thread,
      turnId: args.turnId,
    });
  } catch (error) {
    return toolCallFailure(
      error instanceof Error ? error.message : String(error),
    );
  }

  return environmentAttachmentResponse(
    deps,
    args,
    targetEnvironment,
    attachResult,
  );
}

interface HandleEnterWorktreeToolCallArgs {
  currentEnvironment: EnvironmentRow;
  input: unknown;
  thread: Thread;
  turnId: string;
}

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
  | { dataDir: string; checkout: Awaited<ReturnType<typeof inspectGitSource>> }
  | ToolCallResponse
> {
  try {
    const dataDir = (
      await ensureHostSessionReadyForWork(deps, { hostId: args.hostId })
    ).dataDir;
    const checkout = await inspectGitSource(deps, args);
    return { dataDir, checkout };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolCallFailure(`Could not create an isolated worktree: ${message}`);
  }
}

function inspectGitSource(
  deps: AppDeps,
  args: { hostId: string; sourcePath: string },
) {
  return callHostRetryableOnlineRpc(deps, {
    hostId: args.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.inspect_git_source",
      path: args.sourcePath,
      remoteRefresh: "background",
    },
  });
}

function resolveWorktreeCheckoutBase(
  checkout: Awaited<ReturnType<typeof inspectGitSource>>,
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
  const refusal = foreignProviderOwnedPathRefusal(deps.db, {
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
        `Recorded that this thread stays in ${latestEnvironment.path ?? "the project checkout"}. bb will not ask you to enter a worktree again in this thread. Continue working in the current directory.`,
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
