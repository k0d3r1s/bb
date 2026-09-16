import {
  buildFastForwardPrimaryPlan,
  buildGitInvocation,
  buildRebasePrimaryPreflightPlan,
  buildRebaseRecoveryInvocation,
  executeGit,
  formatResults,
} from "./runtime.mjs";

export const gitOperations = Object.freeze([
  "status",
  "diff",
  "log",
  "add",
  "commit",
  "rebase_primary",
  "rebase_continue",
  "rebase_abort",
  "fast_forward_primary",
]);

export function buildRuntimeGitTool({
  workspaceFor,
  executeGitOperation = executeGit,
}) {
  return {
    name: "runtime_git",
    description:
      "Run a typed Git status, diff, log, add, commit, primary rebase or recovery, or primary fast-forward operation in the authorized checkout of the current project.",
    instructions:
      "Use runtime_git when its fixed operations fit. Add accepts explicit relative paths only; commit rejects control tags and prohibited trailers and runs the project's declared commit preparation generators first. rebase_primary and fast_forward_primary accept no ref or target and operate only between the current managed BB branch and a primary checkout already on main/master. If rebase_primary stops for conflicts, use rebase_continue after resolving them or rebase_abort to restore the branch.",
    presentation: {
      label: { pending: "Running typed Git", completed: "Ran typed Git" },
      icon: { glyph: "GitBranch" },
    },
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: { type: "string", enum: gitOperations },
        staged: { type: "boolean" },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 500 },
        },
        message: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
    async execute(params, ctx) {
      const { policy, workspace } = await workspaceFor(ctx.threadId);
      const operation = params?.operation;
      if (operation === "fast_forward_primary") {
        buildFastForwardPrimaryPlan(policy, workspace);
      } else if (operation === "rebase_primary") {
        buildRebasePrimaryPreflightPlan(policy, workspace);
      } else if (
        operation === "rebase_continue" ||
        operation === "rebase_abort"
      ) {
        buildRebaseRecoveryInvocation(workspace, operation);
      } else {
        buildGitInvocation(workspace.hostRoot, params);
      }
      return formatResults(
        await executeGitOperation(policy, workspace, params, { signal: ctx.signal }),
      );
    },
  };
}
