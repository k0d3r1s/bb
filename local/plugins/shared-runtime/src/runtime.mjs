import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANIFEST_FILE_NAME,
  PRIMARY_ROOT_PLACEHOLDER,
  expandDependencies,
  readManifest,
  substitutePlaceholders,
} from "./manifest.mjs";
import { RUNTIME_ROOT_NAME, defaultRuntimeRoot } from "./registry.mjs";

const OUTPUT_LIMIT_BYTES = 120_000;
const memoryLocks = new Map();
let lockSequence = 0;
export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isolationSourcePath = path.join(pluginRoot, "native/landlock-run.go");
const assetsSourceDirectory = path.join(pluginRoot, "assets");
const isolationRuntimeDirectory = ".bb-runtime";
const isolationLauncherName = "landlock-run";
const runtimeAssetsDirectoryName = "assets";
export const ISOLATION_SELF_TEST_OPERATION = "isolation_self_test";
const ENVIRONMENT_ID_PATTERN = /^env_[a-z0-9]+$/i;

function deny(message) {
  throw new Error(`Shared runtime denied: ${message}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    deny(`${label} is missing or invalid`);
  }
  return value;
}

function normalizeAbsolute(value) {
  return path.resolve(assertNonEmptyString(value, "absolute path"));
}

function samePath(left, right) {
  return normalizeAbsolute(left) === normalizeAbsolute(right);
}

function assertEnvironmentId(environmentId, label) {
  if (typeof environmentId !== "string" || !ENVIRONMENT_ID_PATTERN.test(environmentId)) {
    deny(`${label} is invalid`);
  }
  return environmentId;
}

function requireManifest(policy) {
  if (!policy?.manifest) {
    deny(
      `project manifest ${MANIFEST_FILE_NAME} is unavailable${policy?.manifestError ? `: ${policy.manifestError}` : ""}`,
    );
  }
  return policy.manifest;
}

function assertManifestCurrent(policy) {
  const manifest = requireManifest(policy);
  if (policy.manifestStale) {
    deny(
      `project manifest ${MANIFEST_FILE_NAME} changed since installation; run the shared runtime "sync" operation from the primary checkout`,
    );
  }
  return manifest;
}

function directWorktreePath(policy, environmentId) {
  assertEnvironmentId(environmentId, "environment id");
  return path.join(policy.worktreeRoot, environmentId, policy.worktreeDirectoryName);
}

function worktreeContainerRoot(policy, environmentId) {
  const manifest = requireManifest(policy);
  return path.posix.join(
    manifest.worktrees.containerRoot,
    environmentId,
    policy.worktreeDirectoryName,
  );
}

export function validateWorkspace({
  policy,
  context,
  resolvedEnvironmentPath,
  resolvedGitCommonDir,
}) {
  if (context.projectId !== policy.projectId) {
    deny("project mismatch");
  }
  if (context.hostId !== policy.trustedHostId) {
    deny("host mismatch");
  }
  if (!context.environmentPath) {
    deny("environment path is missing");
  }
  if (!samePath(resolvedGitCommonDir, policy.gitCommonDir)) {
    deny("foreign repository");
  }

  const primaryRoot = normalizeAbsolute(policy.primaryRoot);
  if (samePath(resolvedEnvironmentPath, primaryRoot)) {
    if (context.workspaceProvisionType !== "unmanaged") {
      deny("primary checkout has an invalid provision type");
    }
    return {
      branchName: context.branchName,
      containerRoot: null,
      environmentId: context.environmentId,
      hostRoot: primaryRoot,
      kind: "primary",
    };
  }

  if (context.workspaceProvisionType !== "managed-worktree") {
    deny("non-primary environment is not a managed worktree");
  }
  const expected = directWorktreePath(policy, context.environmentId);
  if (!samePath(context.environmentPath, expected)) {
    deny("environment path is outside its assigned worktree");
  }
  if (!samePath(resolvedEnvironmentPath, expected)) {
    deny("resolved environment path escaped or is nested");
  }

  return {
    branchName: context.branchName,
    containerRoot: worktreeContainerRoot(policy, context.environmentId),
    environmentId: context.environmentId,
    hostRoot: expected,
    kind: "managed-worktree",
  };
}

function containerName(policy, role) {
  const name = policy.containers?.[role];
  if (typeof name !== "string" || name === "") {
    deny(`container role ${JSON.stringify(role)} is not installed for this project`);
  }
  return name;
}

function dockerExec(policy, container, workdir, executable, args = [], options = {}) {
  const environment = options.environment ?? {};
  const environmentArgs = Object.entries(environment).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
  return {
    command: policy.dockerPath,
    args: [
      "exec",
      ...environmentArgs,
      "--workdir",
      workdir,
      containerName(policy, container),
      executable,
      ...args,
    ],
    rejectNonEmptyStdout: options.rejectNonEmptyStdout === true,
  };
}

function relativeInside(root, target, label) {
  const relative = path.relative(normalizeAbsolute(root), normalizeAbsolute(target));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    deny(`${label} is outside its expected root`);
  }
  return relative;
}

function toPosixRelative(relative) {
  return relative.split(path.sep).join("/");
}

function containerMountPath(policy, mount) {
  return mount.container === PRIMARY_ROOT_PLACEHOLDER
    ? normalizeAbsolute(policy.primaryRoot)
    : mount.container;
}

export function hostPathInContainer(policy, hostPath, role) {
  const manifest = requireManifest(policy);
  const container = manifest.containers[role];
  if (!container) {
    deny(`container role ${JSON.stringify(role)} is not declared`);
  }
  const absolute = normalizeAbsolute(hostPath);
  const primaryRoot = normalizeAbsolute(policy.primaryRoot);
  if (absolute === primaryRoot || absolute.startsWith(`${primaryRoot}${path.sep}`)) {
    const relative = toPosixRelative(path.relative(primaryRoot, absolute));
    let best = null;
    for (const mount of container.mounts) {
      const hostPrefix = mount.host === "." ? "" : `${mount.host}/`;
      const matches =
        mount.host === "." || relative === mount.host || relative.startsWith(hostPrefix);
      if (!matches) {
        continue;
      }
      if (best === null || mount.host.length > best.host.length) {
        best = mount;
      }
    }
    if (best === null) {
      deny(`primary checkout path is not mounted in container ${role}`);
    }
    const remainder =
      best.host === "." ? relative : relative === best.host ? "" : relative.slice(best.host.length + 1);
    return path.posix.join(containerMountPath(policy, best), remainder);
  }
  const relative = relativeInside(policy.worktreeRoot, absolute, "worktree path");
  return path.posix.join(manifest.worktrees.containerRoot, toPosixRelative(relative));
}

function isolationLauncherPath(policy, role) {
  return hostPathInContainer(
    policy,
    path.join(policy.primaryRoot, isolationRuntimeDirectory, isolationLauncherName),
    role,
  );
}

function runtimeAssetsPath(policy, role) {
  return hostPathInContainer(
    policy,
    path.join(policy.primaryRoot, isolationRuntimeDirectory, runtimeAssetsDirectoryName),
    role,
  );
}

function builtinScratchPaths(workspace) {
  assertEnvironmentId(workspace.environmentId, "workspace environment id");
  const name = `bb-runtime-${workspace.environmentId}`;
  return [
    path.posix.join("/tmp", name),
    path.posix.join("/var/tmp", name),
    path.posix.join("/dev/shm", name),
  ];
}

function namedScratchPath(workspace, scratchName) {
  assertEnvironmentId(workspace.environmentId, "workspace environment id");
  return path.posix.join("/var/tmp", `bb-runtime-${scratchName}-${workspace.environmentId}`);
}

function namedScratchPaths(policy, workspace) {
  const manifest = requireManifest(policy);
  return Object.keys(manifest.scratch).map((name) => namedScratchPath(workspace, name));
}

function allScratchPaths(policy, workspace) {
  return [...namedScratchPaths(policy, workspace), ...builtinScratchPaths(workspace)];
}

function scratchEnvironment(policy, workspace) {
  const manifest = requireManifest(policy);
  const builtin = builtinScratchPaths(workspace);
  const environment = {
    TMP: builtin[0],
    TEMP: builtin[0],
    TMPDIR: builtin[0],
  };
  for (const [name, entry] of Object.entries(manifest.scratch)) {
    for (const variable of entry.environment) {
      environment[variable] = namedScratchPath(workspace, name);
    }
  }
  return environment;
}

function assertManagedQualityWorkspace(workspace) {
  if (workspace.kind !== "managed-worktree" || workspace.containerRoot === null) {
    deny("quality operations require an isolated managed worktree");
  }
}

function isolatedDockerExec(
  policy,
  workspace,
  container,
  workdir,
  executable,
  args = [],
  options = {},
) {
  assertManagedQualityWorkspace(workspace);
  return dockerExec(
    policy,
    container,
    workdir,
    isolationLauncherPath(policy, container),
    [
      "--workspace",
      workspace.containerRoot,
      ...allScratchPaths(policy, workspace).flatMap((scratch) => ["--scratch", scratch]),
      "--",
      executable,
      ...args,
    ],
    {
      ...options,
      environment: {
        ...scratchEnvironment(policy, workspace),
        ...options.environment,
      },
    },
  );
}

function containerPathFor(policy, workspace, role, relative) {
  if (workspace.containerRoot !== null) {
    return relative === "." ? workspace.containerRoot : path.posix.join(workspace.containerRoot, relative);
  }
  return hostPathInContainer(
    policy,
    relative === "." ? policy.primaryRoot : path.join(policy.primaryRoot, relative),
    role,
  );
}

function placeholderVariables(policy, workspace, role, { cwd = null, target = null } = {}) {
  const manifest = requireManifest(policy);
  const builtin = builtinScratchPaths(workspace);
  const variables = {
    env: workspace.environmentId,
    envSlug: workspace.environmentId.replaceAll("_", "-"),
    tmp: builtin[0],
    primaryRoot: normalizeAbsolute(policy.primaryRoot),
    hostRoot: workspace.hostRoot,
    docker: policy.dockerPath,
    worktreeRoot: normalizeAbsolute(policy.worktreeRoot),
  };
  for (const name of Object.keys(manifest.scratch)) {
    variables[`scratch.${name}`] = namedScratchPath(workspace, name);
  }
  for (const otherRole of Object.keys(manifest.containers)) {
    variables[`launcher.${otherRole}`] = isolationLauncherPath(policy, otherRole);
    variables[`runtime.${otherRole}`] = runtimeAssetsPath(policy, otherRole);
    variables[`root.${otherRole}`] = containerPathFor(policy, workspace, otherRole, ".");
  }
  if (role !== null) {
    variables.root = containerPathFor(policy, workspace, role, ".");
    variables.runtime = runtimeAssetsPath(policy, role);
    variables.launcher = isolationLauncherPath(policy, role);
    if (cwd !== null) {
      variables.cwd = containerPathFor(policy, workspace, role, cwd);
    }
  }
  if (target !== null) {
    variables.target = target;
  }
  return variables;
}

function substituteAll(values, variables, label) {
  return values.map((value) => substitutePlaceholders(value, variables, label));
}

function substituteEnvironment(environment, variables, label) {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      name,
      substitutePlaceholders(value, variables, `${label}.${name}`),
    ]),
  );
}

function compileContainerStep(policy, workspace, step, label, target = null) {
  const variables = placeholderVariables(policy, workspace, step.container, {
    cwd: step.cwd,
    target,
  });
  const argv = substituteAll(step.argv, variables, `${label}.argv`);
  const environment = substituteEnvironment(step.environment, variables, `${label}.env`);
  if (target !== null && !step.usesTarget) {
    argv.push(target);
  }
  return isolatedDockerExec(
    policy,
    workspace,
    step.container,
    variables.cwd,
    argv[0],
    argv.slice(1),
    { environment, rejectNonEmptyStdout: step.failOnStdout },
  );
}

const hostInterpreters = Object.freeze({
  bash: "/bin/bash",
  sh: "/bin/sh",
});

function compileHostStep(policy, workspace, step, label, target = null) {
  assertManagedQualityWorkspace(workspace);
  const variables = placeholderVariables(policy, workspace, null, { target });
  const interpreter = hostInterpreters[step.interpreter];
  if (!interpreter) {
    deny(`${label} uses unsupported host interpreter ${JSON.stringify(step.interpreter)}`);
  }
  const argv = substituteAll(step.argv, variables, `${label}.argv`);
  if (target !== null && !step.usesTarget) {
    argv.push(target);
  }
  return {
    command: interpreter,
    args: [path.join(normalizeAbsolute(policy.primaryRoot), step.script), ...argv],
    containers: [...step.containers],
    cwd: workspace.hostRoot,
    environment: substituteEnvironment(step.environment, variables, `${label}.env`),
    rejectNonEmptyStdout: false,
  };
}

function compileStep(policy, workspace, step, label, target = null) {
  return step.kind === "host"
    ? compileHostStep(policy, workspace, step, label, target)
    : compileContainerStep(policy, workspace, step, label, target);
}

function validateOperationTarget(operation, name, target) {
  if (target === undefined || target === null) {
    if (operation.target?.required) {
      deny(`${name} requires a target`);
    }
    return null;
  }
  if (typeof target !== "string" || target === "" || target.includes("\0") || target.length > 500) {
    deny(`${name} target is invalid`);
  }
  if (operation.target === null) {
    deny(`${name} does not accept a target`);
  }
  if (operation.target.variants) {
    if (!Object.hasOwn(operation.target.variants, target)) {
      deny(
        `${name} target must be one of ${Object.keys(operation.target.variants)
          .map((value) => JSON.stringify(value))
          .join(", ")}`,
      );
    }
    return target;
  }
  if (target.startsWith("-") || !operation.target.pattern.test(target)) {
    deny(`${name} target does not match ${operation.target.patternSource}`);
  }
  return target;
}

export function buildContainerPlan(policy, workspace, operation, input = {}) {
  assertManagedQualityWorkspace(workspace);
  const manifest = assertManifestCurrent(policy);
  if (typeof operation !== "string" || !Object.hasOwn(manifest.operations, operation)) {
    deny(`unsupported operation ${JSON.stringify(operation)}`);
  }
  const definition = manifest.operations[operation];
  if (definition.kind === "sequence") {
    if (input?.target !== undefined) {
      deny(`${operation} does not accept a target`);
    }
    return definition.steps.map((step, index) => {
      if (step.reference !== undefined) {
        const referenced = manifest.operations[step.reference];
        return compileStep(policy, workspace, referenced.step, `operations.${step.reference}`);
      }
      return compileStep(policy, workspace, step, `operations.${operation}.steps[${index}]`);
    });
  }
  const target = validateOperationTarget(definition, operation, input?.target);
  if (target !== null && definition.target.variants) {
    return [
      compileStep(
        policy,
        workspace,
        definition.target.variants[target],
        `operations.${operation}.target.variants.${target}`,
      ),
    ];
  }
  return [compileStep(policy, workspace, definition.step, `operations.${operation}`, target)];
}

function isolationProbeRole(policy) {
  const manifest = requireManifest(policy);
  if (manifest.isolation === null) {
    deny("isolation builder is not declared");
  }
  return manifest.isolation.probe ?? manifest.isolation.builder;
}

export function buildIsolationSelfTestInvocation(
  policy,
  workspace,
  selectedProbe,
  primaryProbe,
  siblingProbe,
  siblingScratchProbe,
) {
  assertManagedQualityWorkspace(workspace);
  const branchName = validateManagedWorktreeBranch(workspace);
  for (const [value, label] of [
    [selectedProbe, "selected isolation probe"],
    [primaryProbe, "primary isolation probe"],
    [siblingProbe, "sibling isolation probe"],
    [siblingScratchProbe, "sibling scratch isolation probe"],
  ]) {
    assertNonEmptyString(value, label);
    if (!path.posix.isAbsolute(value)) {
      deny(`${label} must be an absolute container path`);
    }
  }
  const role = isolationProbeRole(policy);
  return dockerExec(
    policy,
    role,
    workspace.containerRoot,
    isolationLauncherPath(policy, role),
    [
      "--workspace",
      workspace.containerRoot,
      ...allScratchPaths(policy, workspace).flatMap((scratch) => ["--scratch", scratch]),
      "--self-test",
      "--allow-write",
      selectedProbe,
      "--deny-write",
      primaryProbe,
      "--deny-write",
      siblingProbe,
      "--deny-write",
      siblingScratchProbe,
      "--git-workspace",
      workspace.containerRoot,
      "--git-ref",
      `refs/heads/${branchName}`,
    ],
    { environment: scratchEnvironment(policy, workspace) },
  );
}

export function buildPrecommitGenerationPlan(policy, workspace, { available = null } = {}) {
  assertManagedQualityWorkspace(workspace);
  const manifest = assertManifestCurrent(policy);
  const plan = [];
  manifest.git.generators.forEach((generator, index) => {
    if (generator.requires !== null && available !== null && !available.has(generator.requires)) {
      return;
    }
    plan.push({
      generator,
      invocation: compileContainerStep(
        policy,
        workspace,
        generator.step,
        `git.prepareCommit.generators[${index}]`,
      ),
    });
  });
  return plan;
}

function validateRelativePath(value) {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    deny("path is missing or invalid");
  }
  if (path.isAbsolute(value) || value.startsWith("-")) {
    deny("path must be relative and may not be an option");
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    deny("path escapes the workspace");
  }
  return normalized;
}

export function buildSearchInvocation(workspaceRoot, input, defaultPath = ".") {
  const query = assertNonEmptyString(input?.query, "search query");
  if (query.includes("\0") || query.length > 1_000) {
    deny("search query is invalid");
  }
  const requestedPath = input?.path;
  const fallback = defaultPath === "." ? "." : defaultPath;
  const rawPath =
    typeof requestedPath === "string" && requestedPath.trim() === ""
      ? fallback
      : (requestedPath ?? fallback);
  const searchPath = rawPath === "." ? "." : validateRelativePath(rawPath);
  return {
    acceptedExitCodes: [0, 1],
    command: "rg",
    args: ["--color=never", "--line-number", "--fixed-strings", "--", query, searchPath],
    cwd: workspaceRoot,
  };
}

const gitSafetyArgs = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
]);

function safeGitArgs(args) {
  return [...gitSafetyArgs, ...args];
}

function buildFixedGitInvocation(workspaceRoot, args) {
  return {
    command: "git",
    args: safeGitArgs(args),
    cwd: workspaceRoot,
  };
}

export function buildGitInvocation(workspaceRoot, input) {
  switch (input?.operation) {
    case "status":
      return {
        command: "git",
        args: safeGitArgs(["status", "--short", "--branch"]),
        cwd: workspaceRoot,
      };
    case "diff":
      return {
        command: "git",
        args: safeGitArgs(
          input.staged === true ? ["diff", "--cached", "--"] : ["diff", "--"],
        ),
        cwd: workspaceRoot,
      };
    case "log":
      return {
        command: "git",
        args: safeGitArgs(["log", "-20", "--oneline", "--decorate"]),
        cwd: workspaceRoot,
      };
    case "add": {
      if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 100) {
        deny("path list is missing or invalid");
      }
      return {
        command: "git",
        args: safeGitArgs(["add", "--", ...input.paths.map(validateRelativePath)]),
        cwd: workspaceRoot,
      };
    }
    case "commit": {
      const message = assertNonEmptyString(input.message, "commit message");
      if (
        message.length > 500 ||
        message.includes("\0") ||
        /\[[^\]\r\n]+\]/.test(message) ||
        /(?:Co-Authored-By|Claude-Session)\s*:/i.test(message)
      ) {
        deny("commit message contains prohibited control text");
      }
      return {
        command: "git",
        args: safeGitArgs(["commit", "--no-verify", "-m", message]),
        cwd: workspaceRoot,
      };
    }
    default:
      deny(`unsupported git operation ${JSON.stringify(input?.operation)}`);
  }
}

function validateManagedWorktreeBranch(workspace) {
  if (workspace.kind !== "managed-worktree") {
    deny("primary fast-forward requires a managed worktree");
  }
  const branchName = assertNonEmptyString(workspace.branchName, "worktree branch");
  if (
    !/^bb\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branchName) ||
    branchName.includes("..") ||
    branchName.includes("//") ||
    branchName.includes("@{") ||
    branchName.endsWith("/") ||
    branchName.endsWith(".") ||
    branchName.endsWith(".lock")
  ) {
    deny("worktree branch is outside the managed BB namespace");
  }
  return branchName;
}

export function buildFastForwardPrimaryPlan(policy, workspace) {
  const branchName = validateManagedWorktreeBranch(workspace);
  return [
    buildFixedGitInvocation(policy.primaryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    buildFixedGitInvocation(policy.primaryRoot, [
      "merge",
      "--ff-only",
      `refs/heads/${branchName}`,
    ]),
  ];
}

export function buildRebasePrimaryInvocation(_policy, workspace, primaryBranch) {
  validateManagedWorktreeBranch(workspace);
  if (primaryBranch !== "main" && primaryBranch !== "master") {
    deny(`primary checkout is on non-mainline branch ${JSON.stringify(primaryBranch)}`);
  }
  return buildFixedGitInvocation(
    workspace.hostRoot,
    ["rebase", `refs/heads/${primaryBranch}`],
  );
}

export function buildRebasePrimaryPreflightPlan(policy, workspace) {
  const branchName = validateManagedWorktreeBranch(workspace);
  const [primaryBranchInvocation] = buildFastForwardPrimaryPlan(policy, workspace);
  return {
    branchName,
    invocations: [
      primaryBranchInvocation,
      buildFixedGitInvocation(workspace.hostRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]),
      buildFixedGitInvocation(workspace.hostRoot, ["status", "--porcelain"]),
    ],
  };
}

export function buildRebaseRecoveryInvocation(workspace, operation) {
  validateManagedWorktreeBranch(workspace);
  if (operation === "rebase_continue") {
    return buildFixedGitInvocation(workspace.hostRoot, [
      "-c",
      "core.editor=true",
      "rebase",
      "--continue",
    ]);
  }
  if (operation === "rebase_abort") {
    return buildFixedGitInvocation(workspace.hostRoot, ["rebase", "--abort"]);
  }
  deny(`unsupported rebase recovery operation ${JSON.stringify(operation)}`);
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessIdentity(pid) {
  try {
    const [bootId, processStat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const statFields = processStat
      .slice(processStat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (statFields.length > 19 && statFields[19] !== "") {
      return `proc:${bootId.trim()}:${statFields[19]}`;
    }
  } catch {
  }
  return new Promise((resolve) => {
    const child = spawn("/bin/ps", ["-o", "lstart=", "-p", `${pid}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      const identity = output.trim();
      finish(code === 0 && identity !== "" ? identity : null);
    });
  });
}

async function processStartedAt(identity) {
  if (identity.startsWith("proc:")) {
    const startTicks = Number(identity.slice(identity.lastIndexOf(":") + 1));
    let uptimeSeconds;
    try {
      uptimeSeconds = Number((await readFile("/proc/uptime", "utf8")).split(/\s+/, 1)[0]);
    } catch {
      return null;
    }
    if (Number.isFinite(startTicks) && Number.isFinite(uptimeSeconds)) {
      return Date.now() - uptimeSeconds * 1_000 + startTicks * 10;
    }
    return null;
  }
  const startedAt = Date.parse(identity);
  return Number.isFinite(startedAt) ? startedAt : null;
}

async function ownerProcessExists(owner) {
  if (!Number.isInteger(owner?.pid) || !(await processExists(owner.pid))) {
    return false;
  }
  const identity = await readProcessIdentity(owner.pid);
  if (identity === null) {
    return true;
  }
  if (typeof owner.processIdentity === "string" && owner.processIdentity !== "") {
    return owner.processIdentity === identity;
  }
  let startedAt;
  try {
    startedAt = await processStartedAt(identity);
  } catch {
    return true;
  }
  return (
    startedAt === null ||
    !Number.isFinite(owner.createdAt) ||
    owner.createdAt + 2_000 >= startedAt
  );
}

function lockMode(options) {
  const mode = options.mode ?? "exclusive";
  if (mode !== "shared" && mode !== "exclusive") {
    deny(`unsupported lock mode ${JSON.stringify(mode)}`);
  }
  return mode;
}

function createLockOwner(options, mode) {
  const supplied = options.owner ?? {};
  return {
    createdAt: Date.now(),
    environmentId:
      typeof supplied.environmentId === "string" && supplied.environmentId !== ""
        ? supplied.environmentId
        : "unknown environment",
    id: `${process.pid}-${Date.now()}-${lockSequence += 1}`,
    mode,
    operation:
      typeof supplied.operation === "string" && supplied.operation !== ""
        ? supplied.operation
        : "an operation",
    pid: process.pid,
  };
}

function lockWaitMessage(label, owner) {
  const createdAt = Number.isFinite(owner?.createdAt)
    ? new Date(owner.createdAt).toISOString()
    : "an unknown time";
  const environmentId =
    typeof owner?.environmentId === "string" && owner.environmentId !== ""
      ? owner.environmentId
      : `pid ${owner?.pid ?? "unknown"}`;
  const operation =
    typeof owner?.operation === "string" && owner.operation !== ""
      ? owner.operation
      : "an operation";
  return `Shared runtime waiting for ${label} held by ${environmentId} running ${operation} since ${createdAt}.`;
}

function reportLockWait(options, owner) {
  if (typeof options.onWait === "function") {
    options.onWait(lockWaitMessage(options.label ?? "lock", owner));
  }
}

function memoryLockState(lockAdapter, key) {
  const existing = lockAdapter.get(key);
  if (existing?.kind === "platform-rw-lock") {
    return existing;
  }
  const state = {
    kind: "platform-rw-lock",
    queue: [],
    readers: new Map(),
    writer: null,
  };
  lockAdapter.set(key, state);
  return state;
}

function waitingMemoryOwner(state, request) {
  if (state.writer !== null) {
    return state.writer.owner;
  }
  const reader = state.readers.values().next().value;
  if (reader) {
    return reader.owner;
  }
  return state.queue.find((queued) => queued !== request)?.owner ?? null;
}

function drainMemoryLock(lockAdapter, key, state) {
  if (state.writer !== null || state.queue.length === 0) {
    return;
  }
  const first = state.queue[0];
  if (first.mode === "exclusive") {
    if (state.readers.size !== 0) {
      return;
    }
    state.queue.shift();
    state.writer = first;
    first.grant();
    return;
  }
  while (state.queue[0]?.mode === "shared") {
    const reader = state.queue.shift();
    state.readers.set(reader.owner.id, reader);
    reader.grant();
  }
  if (
    state.writer === null &&
    state.readers.size === 0 &&
    state.queue.length === 0 &&
    lockAdapter.get(key) === state
  ) {
    lockAdapter.delete(key);
  }
}

async function waitForMemoryLock(key, lockAdapter, options) {
  const mode = lockMode(options);
  const owner = createLockOwner(options, mode);
  const state = memoryLockState(lockAdapter, key);
  return new Promise((resolve, reject) => {
    let granted = false;
    let released = false;
    const request = {
      grant() {
        granted = true;
        options.signal?.removeEventListener("abort", abort);
        resolve(async () => {
          if (released) {
            return;
          }
          released = true;
          if (mode === "exclusive" && state.writer === request) {
            state.writer = null;
          } else {
            state.readers.delete(owner.id);
          }
          drainMemoryLock(lockAdapter, key, state);
          if (
            state.writer === null &&
            state.readers.size === 0 &&
            state.queue.length === 0 &&
            lockAdapter.get(key) === state
          ) {
            lockAdapter.delete(key);
          }
        });
      },
      mode,
      owner,
    };
    const abort = () => {
      if (granted) {
        return;
      }
      const index = state.queue.indexOf(request);
      if (index !== -1) {
        state.queue.splice(index, 1);
      }
      drainMemoryLock(lockAdapter, key, state);
      if (
        state.writer === null &&
        state.readers.size === 0 &&
        state.queue.length === 0 &&
        lockAdapter.get(key) === state
      ) {
        lockAdapter.delete(key);
      }
      reject(options.signal?.reason ?? new Error("operation aborted while waiting for lock"));
    };
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    state.queue.push(request);
    drainMemoryLock(lockAdapter, key, state);
    if (!granted) {
      reportLockWait(options, waitingMemoryOwner(state, request));
    }
  });
}

function safeLockKey(key) {
  return key.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
}

function parseLockOwner(serialized) {
  const owner = JSON.parse(serialized);
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    throw new Error("lock owner pid is invalid");
  }
  return owner;
}

async function readLockOwner(ownerPath) {
  return parseLockOwner(await readFile(ownerPath, "utf8"));
}

async function readOptionalLockOwner(ownerPath) {
  let serialized;
  try {
    serialized = await readFile(ownerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { kind: "missing", owner: null };
    }
    throw error;
  }
  try {
    return { kind: "valid", owner: parseLockOwner(serialized) };
  } catch {
    return { kind: "invalid", owner: null };
  }
}

async function inspectOwnerClaim(ownerPath) {
  const handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    const serialized = await handle.readFile("utf8");
    let owner = null;
    try {
      owner = parseLockOwner(serialized);
    } catch {
    }
    return {
      identity: { device: identity.dev, inode: identity.ino },
      owner,
    };
  } finally {
    await handle.close();
  }
}

function sameClaimIdentity(left, right) {
  return (
    left?.identity?.device === right?.identity?.device &&
    left?.identity?.inode === right?.identity?.inode
  );
}

async function recoverOwnerClaim(ownerPath, observed, hooks = {}) {
  let current;
  try {
    current = await inspectOwnerClaim(ownerPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!sameClaimIdentity(current, observed)) {
    return false;
  }
  const recoveryPrefix = `${path.basename(ownerPath)}.recover-${observed.identity.device}-${observed.identity.inode}-`;
  const recoveryPath = path.join(
    path.dirname(ownerPath),
    `${recoveryPrefix}${process.pid}-${Date.now()}-${lockSequence++}`,
  );
  let contender;
  try {
    contender = await installOwnerClaim(recoveryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (contender === null) {
    return false;
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const contenders = [];
    const names = await readdir(path.dirname(ownerPath));
    for (const name of names) {
      if (!name.startsWith(recoveryPrefix)) {
        continue;
      }
      const contenderPath = path.join(path.dirname(ownerPath), name);
      try {
        const candidate = await inspectOwnerClaim(contenderPath);
        if (candidate.owner !== null && (await ownerProcessExists(candidate.owner))) {
          contenders.push({
            createdAt: Number.isFinite(candidate.owner.createdAt)
              ? candidate.owner.createdAt
              : Number.POSITIVE_INFINITY,
            path: contenderPath,
          });
        } else {
          await rm(contenderPath, { force: true });
        }
      } catch (inspectionError) {
        if (inspectionError?.code === "ENOENT") {
          continue;
        }
        throw inspectionError;
      }
    }
    contenders.sort(
      (left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path),
    );
    if (contenders[0]?.path !== recoveryPath) {
      return false;
    }
    await hooks.afterElection?.();
    try {
      current = await inspectOwnerClaim(ownerPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (!sameClaimIdentity(current, observed)) {
      return false;
    }
    await rm(ownerPath, { force: true });
    await hooks.afterRemove?.();
    return true;
  } finally {
    await rm(recoveryPath, { force: true });
  }
}

async function installOwnerClaim(ownerPath) {
  const temporaryDirectory = await mkdtemp(
    path.join(path.dirname(ownerPath), `.${path.basename(ownerPath)}.init-`),
  );
  try {
    const temporaryOwnerPath = path.join(temporaryDirectory, "owner.json");
    const processIdentity = await readProcessIdentity(process.pid);
    if (processIdentity === null) {
      throw new Error("cannot determine lock owner process identity");
    }
    const owner = {
      createdAt: Date.now(),
      id: `${process.pid}-${Date.now()}-${lockSequence++}`,
      pid: process.pid,
      processIdentity,
    };
    await writeFile(
      temporaryOwnerPath,
      `${JSON.stringify(owner)}\n`,
      { mode: 0o600 },
    );
    const temporaryIdentity = await lstat(temporaryOwnerPath);
    try {
      await link(temporaryOwnerPath, ownerPath);
      return {
        identity: { device: temporaryIdentity.dev, inode: temporaryIdentity.ino },
        owner,
      };
    } catch (error) {
      if (error?.code === "EEXIST") {
        return null;
      }
      throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function stableDirectoryCanBeReplaced(
  directory,
  markerNames,
  signal,
  graceMs = 1_000,
) {
  const snapshot = async () => {
    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const markers = [];
    for (const markerName of markerNames) {
      try {
        const marker = await lstat(path.join(directory, markerName));
        markers.push({
          device: marker.dev,
          inode: marker.ino,
          modifiedAt: marker.mtimeMs,
          size: marker.size,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        markers.push(null);
      }
    }
    return {
      device: directoryStat.dev,
      inode: directoryStat.ino,
      markers,
      modifiedAt: directoryStat.mtimeMs,
    };
  };
  const before = await snapshot();
  if (before === null) {
    return true;
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (signal?.aborted) {
    throw signal.reason ?? new Error("operation aborted while waiting for lock");
  }
  const after = await snapshot();
  return after === null || JSON.stringify(before) === JSON.stringify(after);
}

async function inspectLegacyLockDirectory(directory, markerNames, signal) {
  let ownerState = await readOptionalLockOwner(path.join(directory, "owner.json"));
  if (ownerState.kind === "valid") {
    if (await ownerProcessExists(ownerState.owner)) {
      return { owner: ownerState.owner, replace: false };
    }
    return { owner: null, replace: true };
  }
  if (!(await stableDirectoryCanBeReplaced(directory, markerNames, signal))) {
    return { owner: null, replace: false };
  }
  ownerState = await readOptionalLockOwner(path.join(directory, "owner.json"));
  if (ownerState.kind === "valid" && (await ownerProcessExists(ownerState.owner))) {
    return { owner: ownerState.owner, replace: false };
  }
  return { owner: null, replace: true };
}

async function scavengeInitializationDebris(
  directory,
  staleBefore = Date.now() - 300_000,
) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const name of names) {
    const isInitializationDebris =
      name.startsWith(".") && (name.includes(".init-") || name.includes(".init."));
    const isRecoveryDebris = name.includes(".owner.json.recover-");
    const isRetiredState = name.includes(".lock.retired-");
    if (!isInitializationDebris && !isRecoveryDebris && !isRetiredState) {
      continue;
    }
    const debrisPath = path.join(directory, name);
    try {
      const debris = await lstat(debrisPath);
      if (isInitializationDebris || isRetiredState) {
        if (debris.mtimeMs < staleBefore) {
          await rm(debrisPath, { recursive: true, force: true });
        }
      } else if (isRecoveryDebris) {
        const recovery = await inspectOwnerClaim(debrisPath);
        if (recovery.owner === null || !(await ownerProcessExists(recovery.owner))) {
          await rm(debrisPath, { force: true });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function installFilesystemLockState(lockPath, claim) {
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify(claim.owner)}\n`,
      { mode: 0o600 },
    );
    await mkdir(path.join(lockPath, "readers"), { mode: 0o700 });
    await mkdir(path.join(lockPath, "writers"), { mode: 0o700 });
    await writeFile(
      path.join(lockPath, "rw.json"),
      `${JSON.stringify({ version: 1 })}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
}

async function ensureFilesystemLockState(key, signal, options) {
  const safeKey = key.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
  const lockRoot = options.lockRoot ?? path.join(defaultRuntimeRoot(), "locks");
  if (!path.isAbsolute(lockRoot)) {
    deny("lock root is not absolute");
  }
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await scavengeInitializationDebris(lockRoot);
  const lockPath = path.join(lockRoot, `${safeKey}.lock`);
  const claimPath = `${lockPath}.owner.json`;
  let lastWaitOwner = null;
  while (true) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("operation aborted while waiting for lock");
    }
    try {
      await readFile(path.join(lockPath, "rw.json"), "utf8");
      return lockPath;
    } catch (stateError) {
      if (stateError?.code !== "ENOENT") {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
    }
    const claim = await installOwnerClaim(claimPath);
    if (claim === null) {
      let observed;
      try {
        observed = await inspectOwnerClaim(claimPath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (observed.owner === null || !(await ownerProcessExists(observed.owner))) {
        await recoverOwnerClaim(claimPath, observed);
        continue;
      }
      const waitSignature = JSON.stringify([
        observed.owner.pid,
        observed.owner.createdAt,
        observed.owner.id,
      ]);
      if (waitSignature !== lastWaitOwner) {
        reportLockWait(options, observed.owner);
        lastWaitOwner = waitSignature;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

    let legacyOwner = null;
    try {
      const currentClaim = await inspectOwnerClaim(claimPath);
      if (!sameClaimIdentity(currentClaim, claim)) {
        continue;
      }
      try {
        await readFile(path.join(lockPath, "rw.json"), "utf8");
        return lockPath;
      } catch (stateError) {
        if (stateError?.code !== "ENOENT") {
          await rm(lockPath, { recursive: true, force: true });
        }
      }
      const legacyState = await inspectLegacyLockDirectory(
        lockPath,
        ["owner.json", "rw.json"],
        signal,
      );
      legacyOwner = legacyState.owner;
      if (legacyState.replace) {
        const verifiedClaim = await inspectOwnerClaim(claimPath);
        if (sameClaimIdentity(verifiedClaim, claim)) {
          await rm(lockPath, { recursive: true, force: true });
          if (await installFilesystemLockState(lockPath, claim)) {
            return lockPath;
          }
        }
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    } finally {
      await recoverOwnerClaim(claimPath, claim);
    }
    if (legacyOwner !== null) {
      const waitSignature = JSON.stringify([legacyOwner.pid, legacyOwner.createdAt]);
      if (waitSignature !== lastWaitOwner) {
        reportLockWait(options, legacyOwner);
        lastWaitOwner = waitSignature;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function installStateGate(gatePath, claim) {
  try {
    await mkdir(gatePath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    await writeFile(
      path.join(gatePath, "owner.json"),
      `${JSON.stringify(claim.owner)}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch (error) {
    await rm(gatePath, { recursive: true, force: true });
    throw error;
  }
}

async function acquireStateGate(lockPath, signal, options = {}) {
  const gatePath = path.join(lockPath, "gate.lock");
  const claimPath = `${gatePath}.owner.json`;
  let lastWaitOwner = null;
  await scavengeInitializationDebris(lockPath);
  while (true) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("operation aborted while waiting for lock");
    }
    let claim;
    try {
      claim = await installOwnerClaim(claimPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (claim === null) {
      let observed;
      try {
        observed = await inspectOwnerClaim(claimPath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (observed.owner === null || !(await ownerProcessExists(observed.owner))) {
        await recoverOwnerClaim(claimPath, observed);
        continue;
      }
      const waitSignature = JSON.stringify([
        observed.owner.pid,
        observed.owner.createdAt,
        observed.owner.id,
      ]);
      if (waitSignature !== lastWaitOwner) {
        reportLockWait(options, observed.owner);
        lastWaitOwner = waitSignature;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }

    let keepClaim = false;
    let legacyOwner = null;
    try {
      const currentClaim = await inspectOwnerClaim(claimPath);
      if (!sameClaimIdentity(currentClaim, claim)) {
        continue;
      }
      const legacyState = await inspectLegacyLockDirectory(
        gatePath,
        ["owner.json"],
        signal,
      );
      legacyOwner = legacyState.owner;
      if (legacyState.replace) {
        const verifiedClaim = await inspectOwnerClaim(claimPath);
        if (sameClaimIdentity(verifiedClaim, claim)) {
          await rm(gatePath, { recursive: true, force: true });
          let installed = false;
          try {
            installed = await installStateGate(gatePath, claim);
          } catch (error) {
            if (error?.code !== "ENOENT") {
              throw error;
            }
          }
          if (installed) {
            keepClaim = true;
            return async () => {
              await rm(gatePath, { recursive: true, force: true });
              await recoverOwnerClaim(claimPath, claim);
            };
          }
        }
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    } finally {
      if (!keepClaim) {
        await recoverOwnerClaim(claimPath, claim);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function activeFilesystemLeases(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const leases = [];
  for (const name of names) {
    const leasePath = path.join(directory, name);
    try {
      const owner = await readLockOwner(leasePath);
      if (
        typeof owner.id !== "string" ||
        owner.id === "" ||
        !Number.isFinite(owner.createdAt)
      ) {
        throw new Error("lock lease metadata is invalid");
      }
      if (await ownerProcessExists(owner)) {
        leases.push({ ...owner, leasePath });
      } else {
        await rm(leasePath, { force: true });
      }
    } catch {
      await rm(leasePath, { force: true });
    }
  }
  return leases.sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

async function releaseFilesystemLease(lockPath, leasePath) {
  while (true) {
    const releaseGate = await acquireStateGate(lockPath);
    if (releaseGate === null) {
      return;
    }
    let removedState = false;
    try {
      await rm(leasePath, { force: true });
      const readers = await activeFilesystemLeases(path.join(lockPath, "readers"));
      const writers = await activeFilesystemLeases(path.join(lockPath, "writers"));
      if (readers.length === 0 && writers.length === 0) {
        const retiredPath = `${lockPath}.retired-${randomUUID()}`;
        await rename(lockPath, retiredPath);
        removedState = true;
        await rm(retiredPath, { recursive: true, force: true });
      }
      return;
    } finally {
      if (!removedState) {
        await releaseGate();
      }
    }
  }
}

async function acquireFilesystemLock(key, options) {
  const mode = lockMode(options);
  const owner = createLockOwner(options, mode);
  const processIdentity = await readProcessIdentity(process.pid);
  if (processIdentity !== null) {
    owner.processIdentity = processIdentity;
  }
  let leasePath = null;
  let lastWaitOwner = null;
  try {
    while (true) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("operation aborted while waiting for lock");
      }
      const lockPath = await ensureFilesystemLockState(key, options.signal, options);
      const releaseGate = await acquireStateGate(lockPath, options.signal, options);
      if (releaseGate === null) {
        continue;
      }
      let stateRetired = false;
      let waitOwner = null;
      try {
        const readersDirectory = path.join(lockPath, "readers");
        const writersDirectory = path.join(lockPath, "writers");
        const readers = await activeFilesystemLeases(readersDirectory);
        let writers = await activeFilesystemLeases(writersDirectory);
        if (mode === "shared") {
          if (writers.length === 0) {
            leasePath = path.join(readersDirectory, `${safeLockKey(owner.id)}.json`);
            await writeFile(leasePath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
            return async () => releaseFilesystemLease(lockPath, leasePath);
          }
          waitOwner = writers[0];
        } else {
          if (leasePath === null) {
            leasePath = path.join(writersDirectory, `${safeLockKey(owner.id)}.json`);
            await writeFile(leasePath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
            writers = await activeFilesystemLeases(writersDirectory);
          }
          if (writers[0]?.id === owner.id && readers.length === 0) {
            return async () => releaseFilesystemLease(lockPath, leasePath);
          }
          waitOwner = writers[0]?.id === owner.id ? readers[0] : writers[0];
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        leasePath = null;
        stateRetired = true;
      } finally {
        await releaseGate();
      }
      if (stateRetired) {
        continue;
      }
      const waitSignature = JSON.stringify([
        waitOwner?.pid,
        waitOwner?.createdAt,
        waitOwner?.environmentId,
        waitOwner?.operation,
      ]);
      if (waitOwner !== null && waitSignature !== lastWaitOwner) {
        reportLockWait(options, waitOwner);
        lastWaitOwner = waitSignature;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    if (leasePath !== null) {
      await releaseFilesystemLease(path.dirname(path.dirname(leasePath)), leasePath);
    }
    throw error;
  }
}

export async function withProjectLock(key, operation, options = {}) {
  const release = options.lockAdapter
    ? await waitForMemoryLock(key, options.lockAdapter, options)
    : await acquireFilesystemLock(key, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}


function invocationExitIsAccepted(invocation, code, signal) {
  if (signal !== null || !Number.isInteger(code)) {
    return false;
  }
  return (invocation.acceptedExitCodes ?? [0]).includes(code);
}

export function runInvocation(invocation, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        ...invocation.environment,
        ...options.env,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    const collect = (current, chunk) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length > OUTPUT_LIMIT_BYTES) {
        overflow = true;
        return combined.subarray(0, OUTPUT_LIMIT_BYTES);
      }
      return combined;
    };
    child.stdout.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      const result = {
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        overflow,
      };
      if (!invocationExitIsAccepted(invocation, code, signal)) {
        reject(
          Object.assign(
            new Error(
              `command failed with exit ${code ?? "null"}${signal ? ` (${signal})` : ""}\n${result.stderr || result.stdout}`,
            ),
            { result },
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function runtimeDirectoryPath(policy) {
  return path.join(normalizeAbsolute(policy.primaryRoot), isolationRuntimeDirectory);
}

export function launcherBuildInvocation(policy, sourcePath, outputPath) {
  const manifest = requireManifest(policy);
  if (manifest.isolation === null) {
    deny("isolation builder is not declared");
  }
  const builder = manifest.isolation.builder;
  return dockerExec(
    policy,
    builder,
    hostPathInContainer(policy, policy.primaryRoot, builder),
    "go",
    [
      "build",
      "-trimpath",
      "-o",
      hostPathInContainer(policy, outputPath, builder),
      hostPathInContainer(policy, sourcePath, builder),
    ],
  );
}

async function directoryDigest(directory) {
  const hash = createHash("sha256");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { digest: hash.digest("hex"), files: [] };
    }
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  for (const name of files) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(path.join(directory, name)));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), files };
}

export async function ensureRuntimeAssets(policy) {
  const runtimeDirectory = runtimeDirectoryPath(policy);
  const target = path.join(runtimeDirectory, runtimeAssetsDirectoryName);
  const marker = path.join(runtimeDirectory, `${runtimeAssetsDirectoryName}.sha256`);
  const { digest, files } = await directoryDigest(assetsSourceDirectory);
  try {
    if ((await readFile(marker, "utf8")).trim() === digest && (await pathExists(target))) {
      return target;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const temporary = path.join(runtimeDirectory, `.${runtimeAssetsDirectoryName}.${process.pid}.tmp`);
  await rm(temporary, { recursive: true, force: true });
  try {
    await mkdir(temporary, { recursive: true, mode: 0o755 });
    for (const name of files) {
      await copyFile(path.join(assetsSourceDirectory, name), path.join(temporary, name));
      await chmod(path.join(temporary, name), 0o644);
    }
    await rm(target, { recursive: true, force: true });
    await rename(temporary, target);
    await writeFile(marker, `${digest}\n`, { mode: 0o600 });
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function ensureIsolationLauncher(policy, options = {}) {
  const source = await readFile(isolationSourcePath);
  const digest = createHash("sha256").update(source).digest("hex");
  const runtimeDirectory = runtimeDirectoryPath(policy);
  const launcher = path.join(runtimeDirectory, isolationLauncherName);
  const marker = path.join(runtimeDirectory, `${isolationLauncherName}.sha256`);
  await ensureRuntimeAssets(policy);
  try {
    const [recordedDigest, launcherStat] = await Promise.all([
      readFile(marker, "utf8"),
      stat(launcher),
    ]);
    if (
      recordedDigest.trim() === digest &&
      launcherStat.isFile() &&
      (launcherStat.mode & 0o111) !== 0
    ) {
      return launcher;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const sourceCopy = path.join(runtimeDirectory, `${isolationLauncherName}.go`);
  const temporaryLauncher = path.join(
    runtimeDirectory,
    `.${isolationLauncherName}.${process.pid}.tmp`,
  );
  const temporaryMarker = `${marker}.${process.pid}.tmp`;
  await rm(temporaryLauncher, { force: true });
  await rm(temporaryMarker, { force: true });
  try {
    await writeFile(sourceCopy, source, { mode: 0o644 });
    const run = options.run ?? runInvocation;
    await run(launcherBuildInvocation(policy, sourceCopy, temporaryLauncher), {
      signal: options.signal,
    });
    await chmod(temporaryLauncher, 0o555);
    await rename(temporaryLauncher, launcher);
    await writeFile(temporaryMarker, `${digest}\n`, { mode: 0o600 });
    await rename(temporaryMarker, marker);
    return launcher;
  } finally {
    await rm(temporaryLauncher, { force: true });
    await rm(temporaryMarker, { force: true });
  }
}

async function resetContainerScratch(policy, workspace, containers, run, signal) {
  const scratchPaths = allScratchPaths(policy, workspace);
  const builtin = builtinScratchPaths(workspace);
  for (const container of containers) {
    await run(
      dockerExec(policy, container, "/", "rm", ["-rf", "--", ...builtin]),
      { signal },
    );
    await run(
      dockerExec(policy, container, "/", "mkdir", ["-p", "-m", "700", "--", ...scratchPaths]),
      { signal },
    );
  }
  return async () => {
    for (const container of containers) {
      await run(
        dockerExec(policy, container, "/", "rm", ["-rf", "--", ...builtin]),
        { signal },
      );
    }
  };
}

function planContainers(policy, plan) {
  return Object.keys(policy.containers).filter((container) =>
    plan.some(
      (invocation) =>
        invocation.args.includes(policy.containers[container]) ||
        invocation.containers?.includes(container),
    ),
  );
}

function executableIsMissing(error) {
  const result = error?.result;
  if (result?.code !== 126 && result?.code !== 127) {
    return false;
  }
  return /(?:executable file not found|not found|no such file)/i.test(
    `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
  );
}

async function ensureHardLink(workspace, relativeSource, relativeTarget) {
  const source = path.join(workspace.hostRoot, relativeSource);
  const target = path.join(workspace.hostRoot, relativeTarget);
  let sourceStat;
  try {
    sourceStat = await stat(source);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  try {
    const targetStat = await stat(target);
    if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
      return false;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporaryTarget = `${target}.bb-link-${process.pid}`;
  await rm(temporaryTarget, { force: true });
  try {
    await link(source, temporaryTarget);
    await rename(temporaryTarget, target);
  } finally {
    await rm(temporaryTarget, { force: true });
  }
  return true;
}

async function prepareCommitOutputs(policy, workspace, run, signal) {
  const manifest = assertManifestCurrent(policy);
  if (manifest.git.generators.length === 0 && manifest.git.hardlinks.length === 0) {
    return;
  }
  const available = new Set();
  for (const generator of manifest.git.generators) {
    if (generator.requires !== null && (await pathExists(path.join(workspace.hostRoot, generator.requires)))) {
      available.add(generator.requires);
    }
  }
  const plan = buildPrecommitGenerationPlan(policy, workspace, { available });
  const paths = [];
  for (const { generator, invocation } of plan) {
    try {
      await run(invocation, { signal });
    } catch (error) {
      if (generator.tolerateMissingExecutable && executableIsMissing(error)) {
        continue;
      }
      throw error;
    }
    for (const stagePath of generator.stages) {
      if (await pathExists(path.join(workspace.hostRoot, stagePath))) {
        paths.push(stagePath);
      }
    }
  }
  for (const hardlink of manifest.git.hardlinks) {
    if (await ensureHardLink(workspace, hardlink.source, hardlink.target)) {
      paths.push(hardlink.target);
    }
  }
  if (paths.length > 0) {
    await run(
      buildGitInvocation(workspace.hostRoot, {
        operation: "add",
        paths: [...new Set(paths)],
      }),
      { signal },
    );
  }
}

async function executeIsolationSelfTest(policy, workspace, run, signal) {
  const role = isolationProbeRole(policy);
  const runtimeDirectory = runtimeDirectoryPath(policy);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const primaryDirectory = await mkdtemp(path.join(runtimeDirectory, "isolation-primary-"));
  const siblingDirectory = await mkdtemp(
    path.join(policy.worktreeRoot, ".bb-runtime-isolation-sibling-"),
  );
  const selectedDirectory = await mkdtemp(
    path.join(workspace.hostRoot, ".bb-runtime-isolation-selected-"),
  );
  const primaryProbe = path.join(primaryDirectory, "unchanged.txt");
  const siblingProbe = path.join(siblingDirectory, "unchanged.txt");
  const selectedProbe = path.join(selectedDirectory, "selected.txt");
  const siblingScratchDirectory = path.posix.join("/tmp", "bb-runtime-env_sibling");
  const siblingScratchProbe = path.posix.join(siblingScratchDirectory, "unchanged.txt");
  const expected = "unchanged\n";
  try {
    await run(dockerExec(policy, role, "/", "mkdir", ["-p", "--", siblingScratchDirectory]), {
      signal,
    });
    await run(dockerExec(policy, role, "/", "touch", [siblingScratchProbe]), { signal });
    await Promise.all([
      writeFile(primaryProbe, expected, { mode: 0o600 }),
      writeFile(siblingProbe, expected, { mode: 0o600 }),
      writeFile(selectedProbe, expected, { mode: 0o600 }),
    ]);
    const invocation = buildIsolationSelfTestInvocation(
      policy,
      workspace,
      hostPathInContainer(policy, selectedProbe, role),
      hostPathInContainer(policy, primaryProbe, role),
      hostPathInContainer(policy, siblingProbe, role),
      siblingScratchProbe,
    );
    const result = await run(invocation, { signal });
    const [primaryAfter, siblingAfter, selectedAfter] = await Promise.all([
      readFile(primaryProbe, "utf8"),
      readFile(siblingProbe, "utf8"),
      readFile(selectedProbe, "utf8"),
    ]);
    if (
      primaryAfter !== expected ||
      siblingAfter !== expected ||
      selectedAfter !== `${expected}allowed\n`
    ) {
      throw new Error("isolation probe modified a protected checkout");
    }
    return [result];
  } finally {
    await run(dockerExec(policy, role, "/", "rm", ["-rf", "--", siblingScratchDirectory]), {
      signal,
    });
    await rm(primaryDirectory, { recursive: true, force: true });
    await rm(siblingDirectory, { recursive: true, force: true });
    await rm(selectedDirectory, { recursive: true, force: true });
  }
}

export async function resolveWorkspace(policy, context) {
  const resolvedEnvironmentPath = await realpath(
    assertNonEmptyString(context.environmentPath, "environment path"),
  );
  const gitResult = await runInvocation({
    command: "/usr/bin/git",
    args: [
      "-C",
      resolvedEnvironmentPath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
  });
  const resolvedGitCommonDir = await realpath(gitResult.stdout.trim());
  return validateWorkspace({
    policy,
    context,
    resolvedEnvironmentPath,
    resolvedGitCommonDir,
  });
}

export async function ensureContainerSymlink(linkPath, target) {
  try {
    const current = await lstat(linkPath);
    if (!current.isSymbolicLink()) {
      deny(`dependency path is not a symbolic link: ${linkPath}`);
    }
    const currentTarget = await readlink(linkPath);
    if (currentTarget !== target) {
      deny(`dependency link has an unexpected target: ${linkPath}`);
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, "dir");
}

async function ensureContainerDependencyDirectory(
  directoryPath,
  sharedTarget,
  sharedSource,
  localDirectories = [],
) {
  try {
    const current = await lstat(directoryPath);
    if (current.isSymbolicLink()) {
      const currentTarget = await readlink(directoryPath);
      if (currentTarget !== sharedTarget) {
        deny(`dependency link has an unexpected target: ${directoryPath}`);
      }
      await rm(directoryPath);
    } else if (!current.isDirectory()) {
      deny(`dependency path is not a directory: ${directoryPath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(directoryPath, { recursive: true });
  const sharedEntries = new Set(
    (await readdir(sharedSource, { withFileTypes: true })).map((entry) => entry.name),
  );
  const localDirectoryNames = new Set(localDirectories);

  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    if (localDirectoryNames.has(entry.name) || sharedEntries.has(entry.name)) {
      continue;
    }
    const stalePath = path.join(directoryPath, entry.name);
    if (!entry.isSymbolicLink()) {
      deny(`dependency mirror contains an unexpected entry: ${stalePath}`);
    }
    const staleTarget = await readlink(stalePath);
    if (staleTarget !== path.posix.join(sharedTarget, entry.name)) {
      deny(`dependency link has an unexpected target: ${stalePath}`);
    }
    await rm(stalePath);
  }

  for (const entryName of sharedEntries) {
    if (localDirectoryNames.has(entryName)) {
      continue;
    }
    await ensureContainerSymlink(
      path.join(directoryPath, entryName),
      path.posix.join(sharedTarget, entryName),
    );
  }

  for (const localDirectoryName of localDirectoryNames) {
    const localPath = path.join(directoryPath, localDirectoryName);
    try {
      const current = await lstat(localPath);
      if (current.isSymbolicLink()) {
        const expectedTarget = path.posix.join(sharedTarget, localDirectoryName);
        if ((await readlink(localPath)) !== expectedTarget) {
          deny(`dependency link has an unexpected target: ${localPath}`);
        }
        await rm(localPath);
      } else if (!current.isDirectory()) {
        deny(`local dependency cache is not a directory: ${localPath}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await mkdir(localPath, { recursive: true, mode: 0o700 });
  }
}

export async function prepareWorktreeDependencies(policy, workspace) {
  if (workspace.kind !== "managed-worktree") {
    return;
  }
  const manifest = assertManifestCurrent(policy);
  const dependencies = await expandDependencies(manifest, policy.primaryRoot, {
    pathExists,
    readDirectory: (directory) => readdir(directory, { withFileTypes: true }),
  });
  for (const dependency of dependencies) {
    const worktreePath = path.join(workspace.hostRoot, dependency.relativePath);
    if (dependency.kind === "link") {
      await ensureContainerSymlink(worktreePath, dependency.containerTarget);
      continue;
    }
    await ensureContainerDependencyDirectory(
      worktreePath,
      dependency.containerTarget,
      path.join(policy.primaryRoot, dependency.relativePath),
      [...dependency.local],
    );
  }
}

function defaultLockWaitReporter(message) {
  process.stderr.write(`${message}\n`);
}

export function captureLockWaitMessages(options = {}) {
  const messages = [];
  return {
    messages,
    options: {
      ...options,
      onLockWait: (message) => {
        messages.push(message);
        options.onLockWait?.(message);
      },
    },
  };
}

export function prependLockWaitMessages(results, messages) {
  if (messages.length === 0) {
    return results;
  }
  const list = Array.isArray(results) ? results : [results];
  return [{ stdout: "", stderr: `${messages.join("\n")}\n` }, ...list];
}

function operationLockOptions(options, workspace, operation, mode, label) {
  return {
    label,
    lockAdapter: options.lockAdapter,
    mode,
    onWait: options.onLockWait ?? defaultLockWaitReporter,
    owner: {
      environmentId: workspace.environmentId ?? workspace.kind ?? "primary",
      operation,
    },
    signal: options.signal,
  };
}

function workspaceLockKey(policy, workspace) {
  if (workspace.kind === "primary") {
    return `${policy.projectId}:environment:primary`;
  }
  assertEnvironmentId(workspace.environmentId, "workspace environment id");
  return `${policy.projectId}:environment:${workspace.environmentId}`;
}

async function withQualityOperationLocks(
  policy,
  workspace,
  operationName,
  operation,
  options,
) {
  return withProjectLock(
    workspaceLockKey(policy, workspace),
    () =>
      withProjectLock(
        policy.projectId,
        operation,
        operationLockOptions(
          options,
          workspace,
          operationName,
          "shared",
          "shared dependency lock",
        ),
      ),
    operationLockOptions(
      options,
      workspace,
      operationName,
      "exclusive",
      "worktree operation lock",
    ),
  );
}

export async function executeContainerOperation(policy, workspace, operation, options = {}) {
  assertManagedQualityWorkspace(workspace);
  assertManifestCurrent(policy);
  const plan =
    operation === ISOLATION_SELF_TEST_OPERATION
      ? null
      : buildContainerPlan(policy, workspace, operation, {
          target: options.target,
        });
  const lockWaits = captureLockWaitMessages(options);
  const results = await withQualityOperationLocks(
    policy,
    workspace,
    operation,
    async () => {
      const run = options.run ?? runInvocation;
      await ensureIsolationLauncher(policy, {
        run,
        signal: options.signal,
      });
      if (operation === ISOLATION_SELF_TEST_OPERATION) {
        const cleanupScratch = await resetContainerScratch(
          policy,
          workspace,
          [isolationProbeRole(policy)],
          run,
          options.signal,
        );
        try {
          return await executeIsolationSelfTest(policy, workspace, run, options.signal);
        } finally {
          await cleanupScratch();
        }
      }
      await prepareWorktreeDependencies(policy, workspace);
      const cleanupScratch = await resetContainerScratch(
        policy,
        workspace,
        planContainers(policy, plan),
        run,
        options.signal,
      );
      try {
        const results = [];
        for (const invocation of plan) {
          const result = await run(invocation, { signal: options.signal });
          if (invocation.rejectNonEmptyStdout && result.stdout.trim() !== "") {
            throw new Error(`format check failed; files need formatting:\n${result.stdout}`);
          }
          results.push(result);
        }
        return results;
      } finally {
        await cleanupScratch();
      }
    },
    lockWaits.options,
  );
  return prependLockWaitMessages(results, lockWaits.messages);
}

export async function executeSearch(policy, workspace, input, options = {}) {
  const manifest = requireManifest(policy);
  return runInvocation(
    buildSearchInvocation(workspace.hostRoot, input, manifest.search.defaultPath),
    options,
  );
}

function commitPreparationContainers(policy) {
  const manifest = requireManifest(policy);
  return [...new Set(manifest.git.generators.map((generator) => generator.step.container))];
}

export async function executeGit(policy, workspace, input, options = {}) {
  const operationName = input?.operation ?? "git";
  const lockWaits = captureLockWaitMessages(options);
  const execute = async () => {
    const run = options.run ?? runInvocation;
    if (input?.operation === "fast_forward_primary") {
      const [branchInvocation, mergeInvocation] = buildFastForwardPrimaryPlan(
        policy,
        workspace,
      );
      const branchResult = await run(branchInvocation, { signal: options.signal });
      const primaryBranch = branchResult.stdout.trim();
      if (primaryBranch !== "main" && primaryBranch !== "master") {
        deny(`primary checkout is on non-mainline branch ${JSON.stringify(primaryBranch)}`);
      }
      const mergeResult = await run(mergeInvocation, { signal: options.signal });
      return [branchResult, mergeResult];
    }
    if (input?.operation === "rebase_primary") {
      const { branchName, invocations } = buildRebasePrimaryPreflightPlan(
        policy,
        workspace,
      );
      const [primaryBranchInvocation, worktreeBranchInvocation, statusInvocation] =
        invocations;
      const primaryBranchResult = await run(primaryBranchInvocation, {
        signal: options.signal,
      });
      const primaryBranch = primaryBranchResult.stdout.trim();
      const worktreeBranchResult = await run(worktreeBranchInvocation, {
        signal: options.signal,
      });
      if (worktreeBranchResult.stdout.trim() !== branchName) {
        deny("managed worktree branch does not match its authorized BB branch");
      }
      const statusResult = await run(statusInvocation, { signal: options.signal });
      if (statusResult.stdout.trim() !== "") {
        deny("primary rebase requires a clean managed worktree");
      }
      const rebaseResult = await run(
        buildRebasePrimaryInvocation(policy, workspace, primaryBranch),
        { signal: options.signal },
      );
      return [
        primaryBranchResult,
        worktreeBranchResult,
        statusResult,
        rebaseResult,
      ];
    }
    if (
      input?.operation === "rebase_continue" ||
      input?.operation === "rebase_abort"
    ) {
      return run(buildRebaseRecoveryInvocation(workspace, input.operation), {
        signal: options.signal,
      });
    }
    if (input?.operation === "commit") {
      assertManagedQualityWorkspace(workspace);
      const containers = commitPreparationContainers(policy);
      if (containers.length > 0) {
        await ensureIsolationLauncher(policy, {
          run,
          signal: options.signal,
        });
      }
      const cleanupScratch =
        containers.length > 0
          ? await resetContainerScratch(policy, workspace, containers, run, options.signal)
          : async () => {};
      try {
        await prepareCommitOutputs(policy, workspace, run, options.signal);
      } finally {
        await cleanupScratch();
      }
    }
    return run(buildGitInvocation(workspace.hostRoot, input), {
      signal: options.signal,
    });
  };
  const withWorkspaceLock = (operation = execute) =>
    withProjectLock(
      workspaceLockKey(policy, workspace),
      operation,
      operationLockOptions(
        lockWaits.options,
        workspace,
        operationName,
        "exclusive",
        "worktree operation lock",
      ),
    );
  if (
    operationName === "rebase_primary" ||
    operationName === "fast_forward_primary"
  ) {
    const result = await withWorkspaceLock(() =>
      withProjectLock(
        policy.projectId,
        execute,
        operationLockOptions(
          lockWaits.options,
          workspace,
          operationName,
          "exclusive",
          "shared dependency lock",
        ),
      ),
    );
    return prependLockWaitMessages(result, lockWaits.messages);
  }
  if (operationName === "commit") {
    const result = await withWorkspaceLock(() =>
      withProjectLock(
        policy.projectId,
        execute,
        operationLockOptions(
          lockWaits.options,
          workspace,
          operationName,
          "shared",
          "shared dependency lock",
        ),
      ),
    );
    return prependLockWaitMessages(result, lockWaits.messages);
  }
  const result = await withWorkspaceLock();
  return prependLockWaitMessages(result, lockWaits.messages);
}

export function formatResults(results) {
  const list = Array.isArray(results) ? results : [results];
  return list
    .map((result) => [result.stdout, result.stderr].filter(Boolean).join(""))
    .join("\n")
    .trim() || "Completed successfully with no output.";
}

export { defaultRuntimeRoot, RUNTIME_ROOT_NAME };

export const _testing = Object.freeze({
  inspectOwnerClaim,
  installOwnerClaim,
  invocationExitIsAccepted,
  memoryLocks,
  readProcessIdentity,
  recoverOwnerClaim,
  scavengeInitializationDebris,
  withQualityOperationLocks,
});
