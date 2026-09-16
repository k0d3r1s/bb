import { describeOperations } from "./manifest.mjs";

const PRIMARY_RUNTIME_TOOL_NAMES = Object.freeze([
  "runtime_container",
  "runtime_git",
  "runtime_skill_resource",
  "runtime_ops",
  "runtime_search",
  "runtime_thread",
]);

export const RUNTIME_TOOL_ALIASES = Object.freeze({
  runtime_container: "platform_container",
  runtime_git: "platform_git",
  runtime_skill_resource: "platform_plugin_resource",
  runtime_ops: "platform_runtime",
  runtime_search: "platform_search",
  runtime_thread: "platform_thread",
});

export const RUNTIME_TOOL_NAMES = Object.freeze([
  ...PRIMARY_RUNTIME_TOOL_NAMES,
  ...Object.values(RUNTIME_TOOL_ALIASES),
]);

export const CODEGRAPH_TOOL_NAMES = Object.freeze([
  "codegraph_search",
  "codegraph_context",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_impact",
  "codegraph_node",
  "codegraph_explore",
  "codegraph_status",
  "codegraph_files",
]);

const INSTRUCTION_LIMIT = 4000;

export function buildAgentInstructions(policy) {
  const projectLabel = policy?.manifest?.name ?? policy?.worktreeDirectoryName ?? "this project";
  const lines = [
    `This ${projectLabel} thread uses one shared container runtime for repository language toolchains and quality commands. Run tests, lint, formatting, static analysis, and project-language commands through runtime_container, and manage the shared Docker stack through runtime_ops. Quality operations require a managed worktree and are write-confined to it. Do not ask the user to switch to the primary checkout, run Docker, reinstall the plugin, or reload it for an agent task.`,
    "Normal Git and the host bb CLI remain available under the provider's ordinary capability model; runtime_git and runtime_thread are fixed convenience operations, not blanket prohibitions. Never push, tag, force-update, reset, delete, mutate sibling worktrees, or create merge commits. Provider lifecycle hooks and configured MCP or plugin servers may spawn host child processes normally.",
    "Installed agent skills are agent-wide and may be read with the provider's native file tools; runtime_skill_resource is an optional bounded reader when it is available. Use injected MCP and CodeGraph tools directly rather than replacing shared-container repository commands with host project toolchains.",
  ];
  if (policy?.manifest) {
    const operations = describeOperations(policy.manifest);
    lines.push(
      operations.length > 0
        ? `runtime_container operations declared by this project: ${operations.join("; ")}. The built-in isolation_self_test operation verifies the write boundary.`
        : "This project declares no runtime_container operations; only the built-in isolation_self_test operation is available.",
    );
  }
  if (policy?.manifestStale) {
    lines.push(
      "The project manifest changed after installation. Container, commit, and lifecycle operations are refused until runtime_ops sync re-pins it.",
    );
  }
  let text = lines.join(" ");
  if (text.length > INSTRUCTION_LIMIT) {
    text = `${text.slice(0, INSTRUCTION_LIMIT - 1)}…`;
  }
  return text;
}

export function buildAgentConfiguration(registry, context) {
  const policy = registry.policyFor(context?.project?.id);
  if (!policy || context.host.id !== policy.trustedHostId) {
    return { policy: null, tools: [], context: null };
  }

  return {
    policy,
    tools: [
      ...RUNTIME_TOOL_NAMES,
      ...(policy.codegraphCommand && policy.manifest?.codegraph.enabled !== false
        ? CODEGRAPH_TOOL_NAMES
        : []),
    ],
    context: {
      projectId: context.project.id,
      hostId: context.host.id,
      environmentId: context.environment.id,
      environmentPath: context.environment.path,
      workspaceProvisionType: context.environment.workspaceProvisionType,
      branchName: context.environment.branchName,
    },
  };
}

export async function rehydrateAgentContext(registry, sdk, threadId) {
  if (typeof threadId !== "string" || !/^thr_[a-z0-9]+$/i.test(threadId)) {
    return null;
  }

  let thread;
  try {
    thread = await sdk.threads.get({ threadId });
  } catch {
    return null;
  }
  const policy = thread ? registry.policyFor(thread.projectId) : null;
  if (
    !thread ||
    !policy ||
    typeof thread.environmentId !== "string" ||
    thread.environmentId === ""
  ) {
    return null;
  }

  let environment;
  try {
    environment = await sdk.environments.get({
      environmentId: thread.environmentId,
    });
  } catch {
    return null;
  }
  if (
    !environment ||
    environment.id !== thread.environmentId ||
    environment.projectId !== policy.projectId ||
    environment.hostId !== policy.trustedHostId
  ) {
    return null;
  }

  return {
    projectId: environment.projectId,
    hostId: environment.hostId,
    environmentId: environment.id,
    environmentPath: environment.path,
    workspaceProvisionType: environment.workspaceProvisionType,
    branchName: environment.branchName,
  };
}
