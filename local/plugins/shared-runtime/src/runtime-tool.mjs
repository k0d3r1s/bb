import { spawn as spawnChild } from "node:child_process";
import { readFile as readFileFromDisk } from "node:fs/promises";
import path from "node:path";

import {
  captureLockWaitMessages,
  defaultRuntimeRoot,
  formatResults,
  pluginRoot,
  prependLockWaitMessages,
  runInvocation,
  withProjectLock,
} from "./runtime.mjs";

export const runtimeOperations = Object.freeze([
  "status",
  "diagnose",
  "logs",
  "ensure",
  "recreate",
  "stop",
  "sync",
]);

const hostInterpreters = Object.freeze({
  bash: "/bin/bash",
  sh: "/bin/sh",
});

function deny(message) {
  throw new Error(`Shared runtime denied: ${message}`);
}

function composeProject(policy) {
  if (typeof policy.composeProject !== "string" || policy.composeProject === "") {
    deny("Compose project is not installed for this project");
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(policy.composeProject)) {
    deny("Compose project is invalid");
  }
  return policy.composeProject;
}

function lifecycleInvocation(policy, operation) {
  const manifest = policy.manifest;
  if (!manifest) {
    deny("project manifest is unavailable");
  }
  const argv = manifest.lifecycle[operation];
  if (!argv) {
    deny(`lifecycle operation ${JSON.stringify(operation)} is not declared by the project manifest`);
  }
  const interpreter = hostInterpreters[path.posix.basename(argv[0])];
  if (!interpreter) {
    deny(`lifecycle operation ${JSON.stringify(operation)} uses an unsupported interpreter`);
  }
  const primaryRoot = path.resolve(policy.primaryRoot);
  return {
    command: interpreter,
    args: [path.join(primaryRoot, argv[1]), ...argv.slice(2)],
    cwd: primaryRoot,
  };
}

export function buildRuntimeInvocation(policy, operation) {
  if (!runtimeOperations.includes(operation)) {
    deny("unsupported runtime operation");
  }
  const primaryRoot = path.resolve(policy.primaryRoot);
  if (operation === "status") {
    return {
      command: policy.dockerPath,
      args: [
        "inspect",
        "--format",
        "{{.Name}} {{.State.Running}}",
        ...Object.values(policy.containers),
      ],
      cwd: primaryRoot,
    };
  }
  if (operation === "diagnose" || operation === "logs") {
    return {
      command: policy.dockerPath,
      args: [
        "ps",
        "--all",
        "--filter",
        `label=com.docker.compose.project=${composeProject(policy)}`,
        "--format",
        operation === "logs"
          ? "{{.Names}}"
          : '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.service"}}',
      ],
      cwd: primaryRoot,
    };
  }
  if (operation === "ensure" || operation === "recreate" || operation === "stop") {
    return lifecycleInvocation(policy, operation);
  }
  return {
    command: process.execPath,
    args: [
      path.join(pluginRoot, "bin", "bb-shared-runtime.mjs"),
      "sync",
      "--project-id",
      policy.projectId,
      ...(policy.manifestPath ? ["--manifest", policy.manifestPath] : []),
      "--no-reload",
    ],
    cwd: primaryRoot,
  };
}

export function buildRuntimeLogInvocation(policy, containerName) {
  if (
    typeof containerName !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)
  ) {
    deny("diagnostic container name is invalid");
  }
  return {
    command: policy.dockerPath,
    args: ["logs", "--tail", "200", containerName],
    cwd: path.resolve(policy.primaryRoot),
  };
}

export async function schedulePluginReload(policy, options = {}) {
  const spawn = options.spawn ?? spawnChild;
  const child = spawn(
    "/bin/bash",
    [path.join(pluginRoot, "scripts", "reload.sh"), policy.projectId],
    {
      cwd: policy.primaryRoot,
      detached: true,
      env: {
        ...process.env,
        ...(policy.bbCli ? { BB_CLI: policy.bbCli } : {}),
      },
      stdio: "ignore",
    },
  );
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export function reloadStatusPath(policy, runtimeRoot = policy.runtimeRoot ?? defaultRuntimeRoot()) {
  return path.join(runtimeRoot, `last-plugin-reload.${policy.projectId}.status`);
}

export async function executeRuntimeOperation(
  policy,
  workspace,
  operation,
  options = {},
) {
  if (!workspace?.hostRoot) {
    deny("authorized workspace is missing");
  }
  const execute = async () => {
    const run = options.run ?? runInvocation;
    if (operation === "status") {
      const stackResult = await run(buildRuntimeInvocation(policy, operation), {
        signal: options.signal,
      });
      try {
        const reloadStatus = await (options.readFile ?? readFileFromDisk)(
          reloadStatusPath(policy, options.runtimeRoot),
          "utf8",
        );
        return [
          stackResult,
          { stdout: `Last plugin reload: ${reloadStatus}`, stderr: "" },
        ];
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        return stackResult;
      }
    }
    if (operation === "logs") {
      const discoveryResult = await run(buildRuntimeInvocation(policy, operation), {
        signal: options.signal,
      });
      const containerNames = discoveryResult.stdout
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean);
      const results = [discoveryResult];
      for (const containerName of containerNames) {
        results.push(
          await run(buildRuntimeLogInvocation(policy, containerName), {
            signal: options.signal,
          }),
        );
      }
      if (containerNames.length === 0) {
        results.push({
          stdout: "No containers exist for the configured Compose project.\n",
          stderr: "",
        });
      }
      return results;
    }
    if (operation !== "sync") {
      return run(buildRuntimeInvocation(policy, operation), { signal: options.signal });
    }

    const installResult = await run(buildRuntimeInvocation(policy, "sync"), {
      signal: options.signal,
    });
    await (options.scheduleReload ?? schedulePluginReload)(policy, {
      spawn: options.spawn,
    });
    return [
      installResult,
      { stdout: "Shared runtime plugin reload scheduled.\n", stderr: "" },
    ];
  };
  if (operation === "status" || operation === "diagnose" || operation === "logs") {
    return execute();
  }
  const lockWaits = captureLockWaitMessages(options);
  const results = await withProjectLock(policy.projectId, execute, {
    label: "shared dependency lock",
    lockAdapter: options.lockAdapter,
    mode: "exclusive",
    onWait: lockWaits.options.onLockWait,
    owner: {
      environmentId: workspace.environmentId ?? workspace.kind ?? "primary",
      operation,
    },
    signal: options.signal,
  });
  return prependLockWaitMessages(results, lockWaits.messages);
}

export function buildRuntimeOpsTool({
  policyFor,
  workspaceFor,
  executeOperation = executeRuntimeOperation,
}) {
  return {
    name: "runtime_ops",
    description:
      "Inspect, diagnose, or reconcile the shared container runtime of the current project from any authorized checkout.",
    instructions:
      "Use runtime_ops instead of asking the user to run primary-checkout, Docker, installer, or plugin reload commands. status reports the configured containers; diagnose lists every container in the configured Compose project; logs returns the last 200 lines from those containers; ensure, recreate, and stop run the fixed lifecycle scripts the project manifest declares; sync re-pins the project manifest from the primary checkout and schedules a plugin reload. No operation accepts a path, command, container, project, or arbitrary argument.",
    presentation: {
      label: { pending: "Reconciling shared runtime", completed: "Reconciled shared runtime" },
      icon: { glyph: "Container" },
    },
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: { type: "string", enum: runtimeOperations },
      },
    },
    async execute(params, ctx) {
      const operation = params?.operation;
      if (!runtimeOperations.includes(operation)) {
        deny("unsupported runtime operation");
      }
      const { policy, workspace } = await workspaceFor(ctx.threadId);
      void policyFor;
      return formatResults(
        await executeOperation(policy, workspace, operation, { signal: ctx.signal }),
      );
    },
  };
}
