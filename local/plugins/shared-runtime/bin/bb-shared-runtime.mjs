#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  MANIFEST_FILE_NAME,
  PRIMARY_ROOT_PLACEHOLDER,
  describeOperations,
  readManifest,
} from "../src/manifest.mjs";
import {
  defaultRuntimeRoot,
  loadPolicy,
  loadRegistry,
  policyPathFor,
  projectsDirectory,
} from "../src/registry.mjs";

const execFile = promisify(execFileCallback);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "shared-runtime";
const usage = `Usage: bb-shared-runtime <command> [options]

Commands (run from the primary checkout of the repository):
  install           Register this repository with the shared runtime plugin and install or reload the plugin
  sync              Re-pin the manifest hash and refresh container names (same as install)
  uninstall         Remove this repository's registration (--remove-plugin also removes the plugin when no project remains)
  list              Show every project registered on this host
  doctor            Verify the registration, manifest, containers, and mounts
  validate          Validate ${MANIFEST_FILE_NAME} and list its operations
  env               Print shell exports for BB_WORKTREES_ROOT and BB_PRIMARY_ROOT
  compose-overlay   Print a Docker Compose overlay that mounts the worktree root into the declared containers

Options:
  --project-id <id>         BB project id when the checkout maps to more than one project
  --primary-root <path>     Register a primary checkout without changing directory
  --manifest <path>         Use a trusted manifest outside the repository root
  --compose-project <name>  Docker Compose project name (otherwise read from the manifest's compose.envFile)
  --docker-socket <path>    Docker socket path (otherwise DOCKER_HOST or the active docker context)
  --worktree-root <path>    BB worktree root (default: $BB_WORKTREES_ROOT or ~/.bb/worktrees)
  --runtime-root <path>     Registry root (default: ~/.bb/shared-runtime)
  --no-reload               Do not reload the plugin after writing the registration
  --remove-plugin           With uninstall: remove the plugin when no registrations remain
  --json                    Machine-readable output for list, doctor, and validate
`;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArguments(argv) {
  const options = { flags: new Set(), values: {} };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (["no-reload", "remove-plugin", "json", "help"].includes(name)) {
      options.flags.add(name);
      continue;
    }
    if (["project-id", "primary-root", "manifest", "compose-project", "docker-socket", "worktree-root", "runtime-root"].includes(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError(`--${name} requires a value`, 2);
      }
      options.values[name] = value;
      index += 1;
      continue;
    }
    throw new CliError(`Unknown option: ${argument}`, 2);
  }
  return { command: positional[0], rest: positional.slice(1), ...options };
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

async function isExecutable(target) {
  try {
    await access(target, fsConstants.X_OK);
    const targetStat = await stat(target);
    return targetStat.isFile();
  } catch {
    return false;
  }
}

async function commandPath(name) {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    if (await isExecutable(candidate)) {
      return realpath(candidate);
    }
  }
  return null;
}

async function resolveBbCli() {
  if (process.env.BB_CLI) {
    const candidate = process.env.BB_CLI;
    if (!path.isAbsolute(candidate) || !(await isExecutable(candidate))) {
      throw new CliError(`BB_CLI is not an existing absolute executable: ${candidate}`);
    }
    return realpath(candidate);
  }
  const onPath = await commandPath("bb");
  if (onPath) {
    return onPath;
  }
  for (const candidate of [
    "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb",
    "/Applications/BB.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb",
    "/opt/homebrew/bin/bb",
    "/usr/local/bin/bb",
  ]) {
    if (await isExecutable(candidate)) {
      return realpath(candidate);
    }
  }
  throw new CliError("Could not resolve the BB CLI. Set BB_CLI to the absolute installed bb executable.");
}

async function bb(cli, args) {
  const { stdout } = await execFile(cli, args, {
    env: { ...process.env, BB_CLI: cli },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function bbJson(cli, args) {
  return JSON.parse(await bb(cli, [...args, "--json"]));
}

async function requirePrimaryCheckout(cwd) {
  const root = await realpath(cwd);
  let commonDir;
  try {
    const { stdout } = await execFile("git", [
      "-C",
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    commonDir = await realpath(stdout.trim());
  } catch {
    throw new CliError(`${root} is not inside a Git repository`);
  }
  const topLevel = (
    await execFile("git", ["-C", root, "rev-parse", "--show-toplevel"])
  ).stdout.trim();
  const primaryRoot = await realpath(topLevel);
  if (path.dirname(commonDir) !== primaryRoot) {
    throw new CliError(
      `Refusing to manage the shared runtime from a linked worktree:\n  worktree: ${primaryRoot}\n  primary:  ${path.dirname(commonDir)}\nRun this command from the primary checkout.`,
    );
  }
  return { primaryRoot, gitCommonDir: commonDir };
}

function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]] = value;
  }
  return values;
}

async function resolveComposeProject(manifest, primaryRoot, options) {
  if (options.values["compose-project"]) {
    return options.values["compose-project"];
  }
  if (manifest.compose.envFile === null || manifest.compose.projectVariable === null) {
    return null;
  }
  const envPath = path.join(primaryRoot, manifest.compose.envFile);
  const values = {};
  for (const candidate of [envPath, `${envPath}.local`]) {
    if (await pathExists(candidate)) {
      Object.assign(values, parseEnvFile(await readFile(candidate, "utf8")));
    }
  }
  const value = values[manifest.compose.projectVariable];
  if (typeof value !== "string" || value === "") {
    throw new CliError(
      `${manifest.compose.projectVariable} is not set in ${manifest.compose.envFile}; pass --compose-project`,
    );
  }
  return value;
}

async function resolveDockerSocket(dockerPath, options) {
  if (options.values["docker-socket"]) {
    return path.resolve(options.values["docker-socket"]);
  }
  const fromEnvironment = process.env.DOCKER_HOST;
  if (typeof fromEnvironment === "string" && fromEnvironment.startsWith("unix://")) {
    return fromEnvironment.slice("unix://".length);
  }
  try {
    const { stdout } = await execFile(dockerPath, [
      "context",
      "inspect",
      "--format",
      '{{(index .Endpoints "docker").Host}}',
    ]);
    const host = stdout.trim();
    if (host.startsWith("unix://")) {
      return host.slice("unix://".length);
    }
  } catch {
  }
  return null;
}

async function resolveCodeGraph() {
  const entry = await commandPath("codegraph");
  if (!entry) {
    return { command: null, root: null };
  }
  let root = path.dirname(entry);
  while (root !== path.dirname(root) && !(await pathExists(path.join(root, "package.json")))) {
    root = path.dirname(root);
  }
  if (root === path.dirname(root)) {
    return { command: null, root: null };
  }
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (manifest.name !== "@colbymchenry/codegraph") {
      return { command: null, root: null };
    }
  } catch {
    return { command: null, root: null };
  }
  return { command: entry, root };
}

async function resolveProject(cli, primaryRoot, options) {
  const projects = await bbJson(cli, ["project", "list"]);
  const matches = [];
  for (const project of projects) {
    for (const source of project.sources ?? []) {
      if (source.type !== "local_path" || typeof source.path !== "string") {
        continue;
      }
      let sourcePath;
      try {
        sourcePath = await realpath(source.path);
      } catch {
        continue;
      }
      if (sourcePath === primaryRoot) {
        matches.push({ project, source });
      }
    }
  }
  const requested = options.values["project-id"];
  const selected = requested
    ? matches.filter(({ project }) => project.id === requested)
    : matches;
  if (selected.length === 0) {
    throw new CliError(
      requested
        ? `BB project ${requested} has no local source at ${primaryRoot}`
        : `No BB project has a local source at ${primaryRoot}. Add the repository as a BB project first.`,
    );
  }
  if (selected.length > 1) {
    throw new CliError(
      `More than one BB project maps to ${primaryRoot}; pass --project-id (${selected
        .map(({ project }) => project.id)
        .join(", ")})`,
    );
  }
  return selected[0];
}

function worktreeDirectoryNameFor(project) {
  const name = typeof project.name === "string" ? project.name.trim() : "";
  if (name === "" || name.includes("/") || name === "." || name === "..") {
    throw new CliError(`BB project ${project.id} has a name that cannot be a worktree directory`);
  }
  return name;
}

async function writeProtectedJson(target, document) {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function ensureProtectedDirectories(runtimeRoot) {
  for (const directory of [runtimeRoot, projectsDirectory(runtimeRoot), path.join(runtimeRoot, "locks")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(directory);
    if ((directoryStat.mode & 0o777) !== 0o700) {
      await execFile("chmod", ["0700", directory]);
    }
  }
}

async function pluginState(cli) {
  const listed = await bbJson(cli, ["plugin", "list"]);
  const plugins = Array.isArray(listed) ? listed : listed.plugins ?? [];
  return plugins.find((plugin) => plugin.id === PLUGIN_ID) ?? null;
}

async function installOrReloadPlugin(cli, { reload }) {
  const existing = await pluginState(cli);
  if (!existing) {
    await bb(cli, ["plugin", "install", "--yes", pluginRoot]);
    return "installed";
  }
  if (!reload) {
    return "registered";
  }
  await bb(cli, ["plugin", "reload", PLUGIN_ID]);
  return "reloaded";
}

function containerNames(manifest, composeProject) {
  const names = {};
  for (const [role, container] of Object.entries(manifest.containers)) {
    if (container.containerName !== null) {
      names[role] = container.containerName;
      continue;
    }
    if (composeProject === null) {
      throw new CliError(
        `containers.${role} needs a Compose project name to derive its container name; pass --compose-project or declare compose.envFile and compose.projectVariable`,
      );
    }
    names[role] = `${composeProject}_${container.service}`;
  }
  return names;
}

async function commandInstall(options, { reloadByDefault }) {
  const runtimeRoot = options.values["runtime-root"]
    ? path.resolve(options.values["runtime-root"])
    : defaultRuntimeRoot();
  const requestedPrimaryRoot = options.values["primary-root"]
    ? path.resolve(options.values["primary-root"])
    : process.cwd();
  const { primaryRoot, gitCommonDir } = await requirePrimaryCheckout(requestedPrimaryRoot);
  const configuredManifestPath = options.values.manifest
    ? path.resolve(options.values.manifest)
    : undefined;
  const loaded = await readManifest(primaryRoot, configuredManifestPath);
  const manifest = loaded.manifest;
  const cli = await resolveBbCli();
  const { project, source } = await resolveProject(cli, primaryRoot, options);
  const dockerPath = await commandPath("docker");
  if (!dockerPath) {
    throw new CliError("docker is not on PATH");
  }
  for (const key of ["user.name", "user.email"]) {
    const { stdout } = await execFile("git", ["-C", primaryRoot, "config", "--get", key]).catch(() => ({ stdout: "" }));
    if (stdout.trim() === "") {
      throw new CliError(`Git ${key} must be configured in the primary checkout before installation`);
    }
  }
  const composeProject = await resolveComposeProject(manifest, primaryRoot, options);
  const dockerSocket = await resolveDockerSocket(dockerPath, options);
  const codegraph = await resolveCodeGraph();
  const worktreeRoot = path.resolve(
    options.values["worktree-root"] ??
      process.env.BB_WORKTREES_ROOT ??
      path.join(homedir(), ".bb", "worktrees"),
  );
  const document = {
    projectId: project.id,
    trustedHostId: source.hostId,
    primaryRoot,
    worktreeRoot,
    worktreeDirectoryName: worktreeDirectoryNameFor(project),
    gitCommonDir,
    dockerPath,
    dockerSocket,
    composeProject,
    containers: containerNames(manifest, composeProject),
    manifestSha256: loaded.digest,
    manifestPath: configuredManifestPath,
    codegraphCommand: codegraph.command,
    codegraphRoot: codegraph.root,
    bbCli: cli,
    installedAt: new Date().toISOString(),
  };
  await ensureProtectedDirectories(runtimeRoot);
  await writeProtectedJson(policyPathFor(project.id, runtimeRoot), document);
  const pluginOutcome = await installOrReloadPlugin(cli, {
    reload: reloadByDefault && !options.flags.has("no-reload"),
  });
  process.stdout.write(
    `Registered ${project.name} (${project.id}) on host ${source.hostId} with manifest ${loaded.digest.slice(0, 12)}; plugin ${pluginOutcome}.\n`,
  );
  process.stdout.write(
    `Containers: ${Object.entries(document.containers)
      .map(([role, name]) => `${role}=${name}`)
      .join(", ")}\n`,
  );
}

async function commandUninstall(options) {
  const runtimeRoot = options.values["runtime-root"]
    ? path.resolve(options.values["runtime-root"])
    : defaultRuntimeRoot();
  const { primaryRoot } = await requirePrimaryCheckout(process.cwd());
  const cli = await resolveBbCli();
  let projectId = options.values["project-id"] ?? null;
  if (projectId === null) {
    const registry = await loadRegistry(runtimeRoot);
    const matching = [...registry.policies.values()].filter(
      (policy) => policy.primaryRoot === primaryRoot,
    );
    if (matching.length !== 1) {
      throw new CliError(
        matching.length === 0
          ? `No registration exists for ${primaryRoot}`
          : "More than one registration matches this checkout; pass --project-id",
      );
    }
    projectId = matching[0].projectId;
  }
  await rm(policyPathFor(projectId, runtimeRoot), { force: true });
  const remaining = await loadRegistry(runtimeRoot);
  if (remaining.policies.size === 0 && options.flags.has("remove-plugin")) {
    if (await pluginState(cli)) {
      await bb(cli, ["plugin", "remove", PLUGIN_ID]);
    }
    process.stdout.write(`Removed registration ${projectId} and the ${PLUGIN_ID} plugin.\n`);
    return;
  }
  if (!options.flags.has("no-reload") && (await pluginState(cli))) {
    await bb(cli, ["plugin", "reload", PLUGIN_ID]);
  }
  process.stdout.write(`Removed registration ${projectId}.\n`);
}

async function commandList(options) {
  const runtimeRoot = options.values["runtime-root"]
    ? path.resolve(options.values["runtime-root"])
    : defaultRuntimeRoot();
  const registry = await loadRegistry(runtimeRoot);
  const rows = [...registry.policies.values()].map((policy) => ({
    projectId: policy.projectId,
    hostId: policy.trustedHostId,
    primaryRoot: policy.primaryRoot,
    composeProject: policy.composeProject ?? null,
    containers: policy.containers,
    manifestStale: policy.manifestStale,
    manifestError: policy.manifestError,
  }));
  if (options.flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ projects: rows, problems: registry.problems }, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("No projects are registered on this host.\n");
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.projectId}  ${row.primaryRoot}  compose=${row.composeProject ?? "-"}  ${row.manifestError ? `manifest error: ${row.manifestError}` : row.manifestStale ? "manifest changed (run sync)" : "ok"}\n`,
    );
  }
  for (const problem of registry.problems) {
    process.stdout.write(`skipped ${problem.path}: ${problem.message}\n`);
  }
}

async function commandValidate(options) {
  const { primaryRoot } = await requirePrimaryCheckout(process.cwd()).catch(async () => ({
    primaryRoot: await realpath(process.cwd()),
  }));
  const loaded = await readManifest(primaryRoot);
  const operations = describeOperations(loaded.manifest);
  if (options.flags.has("json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          digest: loaded.digest,
          containers: Object.keys(loaded.manifest.containers),
          operations,
          lifecycle: Object.keys(loaded.manifest.lifecycle),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`${loaded.path} is valid (sha256 ${loaded.digest.slice(0, 12)}).\n`);
  process.stdout.write(`Containers: ${Object.keys(loaded.manifest.containers).join(", ")}\n`);
  process.stdout.write(`Lifecycle: ${Object.keys(loaded.manifest.lifecycle).join(", ") || "-"}\n`);
  process.stdout.write(`Operations:\n${operations.map((line) => `  ${line}`).join("\n")}\n`);
}

async function commandEnv() {
  const { primaryRoot } = await requirePrimaryCheckout(process.cwd());
  const worktreeRoot = path.resolve(
    process.env.BB_WORKTREES_ROOT ?? path.join(homedir(), ".bb", "worktrees"),
  );
  process.stdout.write(`export BB_WORKTREES_ROOT=${JSON.stringify(worktreeRoot)}\n`);
  process.stdout.write(`export BB_PRIMARY_ROOT=${JSON.stringify(primaryRoot)}\n`);
}

async function commandComposeOverlay() {
  const primaryRoot = await realpath(process.cwd());
  const loaded = await readManifest(primaryRoot);
  const manifest = loaded.manifest;
  const lines = [
    `# Generated by bb-shared-runtime compose-overlay from ${MANIFEST_FILE_NAME}.`,
    "# Apply with: docker compose -f <main compose file> -f <this file> ...",
    "# Source the output of `bb-shared-runtime env` first.",
    "services:",
  ];
  for (const [, container] of Object.entries(manifest.containers)) {
    lines.push(`  ${container.service}:`);
    lines.push("    volumes:");
    lines.push(
      `      - \${BB_WORKTREES_ROOT:?BB_WORKTREES_ROOT must be set}:${manifest.worktrees.containerRoot}`,
    );
    if (container.mounts.some((mount) => mount.container === PRIMARY_ROOT_PLACEHOLDER)) {
      lines.push(
        "      - ${BB_WORKTREES_ROOT:?BB_WORKTREES_ROOT must be set}:${BB_WORKTREES_ROOT:?BB_WORKTREES_ROOT must be set}",
      );
      lines.push(
        "      - ${BB_PRIMARY_ROOT:?BB_PRIMARY_ROOT must be set}:${BB_PRIMARY_ROOT:?BB_PRIMARY_ROOT must be set}",
      );
    }
    for (const mount of container.mounts) {
      if (mount.container === PRIMARY_ROOT_PLACEHOLDER) {
        continue;
      }
      const hostPath = mount.host === "." ? "${BB_PRIMARY_ROOT:?BB_PRIMARY_ROOT must be set}" : `\${BB_PRIMARY_ROOT:?BB_PRIMARY_ROOT must be set}/${mount.host}`;
      lines.push(`      - ${hostPath}:${mount.container}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function inspectMounts(dockerPath, container) {
  const { stdout } = await execFile(dockerPath, [
    "inspect",
    "--format",
    "{{json .Mounts}}",
    container,
  ]);
  return JSON.parse(stdout);
}

async function commandDoctor(options) {
  const runtimeRoot = options.values["runtime-root"]
    ? path.resolve(options.values["runtime-root"])
    : defaultRuntimeRoot();
  const { primaryRoot } = await requirePrimaryCheckout(process.cwd());
  const registry = await loadRegistry(runtimeRoot);
  const candidates = [...registry.policies.values()].filter(
    (policy) => policy.primaryRoot === primaryRoot,
  );
  const findings = [];
  const note = (level, message) => findings.push({ level, message });
  if (candidates.length === 0) {
    note("error", `no registration for ${primaryRoot}; run bb-shared-runtime install`);
  }
  for (const policy of candidates) {
    note("ok", `registration ${policy.projectId} on host ${policy.trustedHostId}`);
    if (policy.manifestError) {
      note("error", `manifest: ${policy.manifestError}`);
      continue;
    }
    if (policy.manifestStale) {
      note("error", "manifest changed since installation; run bb-shared-runtime sync");
    } else {
      note("ok", `manifest hash ${policy.manifestSha256.slice(0, 12)} matches`);
    }
    const loadedPolicy = await loadPolicy(policyPathFor(policy.projectId, runtimeRoot)).catch((error) => {
      note("error", `policy file: ${error.message}`);
      return null;
    });
    if (loadedPolicy) {
      note("ok", "policy file permissions verified");
    }
    const launcher = path.join(primaryRoot, ".bb-runtime", "landlock-run");
    note(
      (await pathExists(launcher)) ? "ok" : "warn",
      (await pathExists(launcher))
        ? "isolation launcher is built"
        : "isolation launcher not built yet (built on first quality operation)",
    );
    for (const [role, name] of Object.entries(policy.containers)) {
      let mounts;
      try {
        mounts = await inspectMounts(policy.dockerPath, name);
      } catch {
        note("error", `container ${role} (${name}) is not running or not created`);
        continue;
      }
      const destinations = new Map(
        mounts.map((mount) => [mount.Destination, mount.Source ?? mount.Name ?? ""]),
      );
      const worktreeRoot = policy.manifest.worktrees.containerRoot;
      if (destinations.has(worktreeRoot)) {
        const source = destinations.get(worktreeRoot);
        let resolved = source;
        try {
          resolved = await realpath(source);
        } catch {
        }
        note(
          resolved === (await realpath(policy.worktreeRoot).catch(() => policy.worktreeRoot)) || source === policy.worktreeRoot
            ? "ok"
            : "warn",
          `container ${role}: ${worktreeRoot} is mounted from ${source}`,
        );
      } else {
        note("error", `container ${role} (${name}) does not mount ${worktreeRoot}`);
      }
      for (const mount of policy.manifest.containers[role].mounts) {
        const expected = mount.container === PRIMARY_ROOT_PLACEHOLDER ? primaryRoot : mount.container;
        if (!destinations.has(expected)) {
          note("error", `container ${role} (${name}) does not mount ${mount.host} at ${expected}`);
        }
      }
      if (policy.manifest.containers[role].mounts.some((mount) => mount.container === PRIMARY_ROOT_PLACEHOLDER) && !destinations.has(policy.worktreeRoot)) {
        note(
          "error",
          `container ${role} (${name}) must also mount ${policy.worktreeRoot} at the identical path for Git worktree metadata`,
        );
      }
    }
  }
  if (options.flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
  } else {
    for (const finding of findings) {
      process.stdout.write(`${finding.level.padEnd(5)} ${finding.message}\n`);
    }
  }
  if (findings.some((finding) => finding.level === "error")) {
    throw new CliError("doctor found errors", 1);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.command || options.flags.has("help") || options.command === "help") {
    process.stdout.write(usage);
    return;
  }
  switch (options.command) {
    case "install":
      return commandInstall(options, { reloadByDefault: true });
    case "sync":
      return commandInstall(options, { reloadByDefault: true });
    case "uninstall":
      return commandUninstall(options);
    case "list":
      return commandList(options);
    case "doctor":
      return commandDoctor(options);
    case "validate":
      return commandValidate(options);
    case "env":
      return commandEnv();
    case "compose-overlay":
      return commandComposeOverlay();
    default:
      throw new CliError(`Unknown command: ${options.command}\n\n${usage}`, 2);
  }
}

main().catch((error) => {
  const message = error instanceof CliError ? error.message : error?.stack ?? String(error);
  process.stderr.write(`${message}\n`);
  process.exit(error instanceof CliError ? error.exitCode : 1);
});

export { parseEnvFile, containerNames, createHash };
