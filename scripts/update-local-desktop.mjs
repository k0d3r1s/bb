import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const upstreamBranch = process.env.BB_LOCAL_UPSTREAM_BRANCH ?? "main";
const forkBranch = process.env.BB_LOCAL_FORK_BRANCH ?? "main";
const upstreamSlug = (
  process.env.BB_LOCAL_UPSTREAM_SLUG ?? "get-bb/bb"
).toLowerCase();
const packagedApp = path.join(
  repoRoot,
  "apps",
  "desktop",
  "release",
  "mac-arm64",
  "bb Local.app",
);
const installedApp = "/Applications/bb Local.app";
const officialApp = "/Applications/bb.app";
const officialProcessPattern = "^/Applications/bb\\.app/Contents/MacOS/bb( |$)";
const localProcessPattern =
  "^/Applications/bb Local\\.app/Contents/MacOS/bb( |$)";
const legacyRuntimePolicyPath = path.join(
  os.homedir(),
  ".bb",
  "platform-runtime",
  "policy.json",
);
const bundledPlatformManifest = path.join(
  repoRoot,
  "local",
  "plugins",
  "shared-runtime",
  "manifests",
  "platform.bb-runtime.json",
);
const localPlugins = [
  {
    id: "shared-runtime",
    directory: "shared-runtime",
    replaces: ["platform-runtime"],
  },
  { id: "dir-skills", directory: "dir-skills" },
];
const npmScriptPolicyEnvironmentKeys = new Set([
  "npm_config_allow_scripts",
  "npm_config_ignore_scripts",
  "npm_config_foreground_scripts",
]);

export function parseLocalUpdateArgs(argv) {
  const options = {
    check: false,
    current: false,
    install: true,
    plugins: true,
    push: true,
  };
  for (const argument of argv) {
    if (argument === "--") continue;
    if (argument === "--check") options.check = true;
    else if (argument === "--current") options.current = true;
    else if (argument === "--skip-install") options.install = false;
    else if (argument === "--skip-plugins") options.plugins = false;
    else if (argument === "--skip-push") options.push = false;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export function pluginSyncAction(requested, expected) {
  if (requested === null) return "install";
  return requested === expected ? "reload" : "reinstall";
}

export function pluginSyncPlan(id, requested, expected, replacements = []) {
  const action = pluginSyncAction(requested, expected);
  const steps = [];
  if (action === "install") steps.push({ action: "install", id });
  if (action === "reinstall") {
    steps.push({ action: "remove", id }, { action: "install", id });
  }
  if (action === "reload" && replacements.length === 0) {
    steps.push({ action: "reload", id });
  }
  for (const replacement of replacements) {
    steps.push({ action: "remove", id: replacement });
  }
  if (replacements.length > 0) steps.push({ action: "reload", id });
  return steps;
}

export function pluginReplacementIds(plugins) {
  return [
    ...new Set(plugins.flatMap((plugin) => plugin.replaces ?? [])),
  ].sort();
}

export function remoteSlug(url) {
  const trimmed = url.trim().replace(/\.git$/u, "");
  const scp = /^[^/]+@[^:]+:(.+)$/u.exec(trimmed);
  const withoutOrigin = scp
    ? scp[1]
    : trimmed.replace(/^[a-z+]+:\/\/[^/]*\//iu, "");
  return withoutOrigin
    .split("/")
    .filter((segment) => segment !== "")
    .slice(-2)
    .join("/")
    .toLowerCase();
}

export function resolveRemoteNames(remotes, overrides = {}) {
  const isUpstream = (remote) => remoteSlug(remote.url) === upstreamSlug;
  const pushesToUpstream = (remote) =>
    (remote.pushUrls ?? [remote.url]).some(
      (url) => remoteSlug(url) === upstreamSlug,
    );
  const upstream = overrides.upstream ?? remotes.find(isUpstream)?.name;
  if (upstream === undefined) {
    throw new Error(
      `no remote matches ${upstreamSlug}; set BB_LOCAL_UPSTREAM_REMOTE or BB_LOCAL_UPSTREAM_SLUG`,
    );
  }
  const candidates = remotes.filter(
    (remote) => remote.name !== upstream && !isUpstream(remote),
  );
  const named = (name) =>
    candidates.find((remote) => remote.name === name)?.name;
  const fork =
    overrides.fork ?? named("fork") ?? named("origin") ?? candidates[0]?.name;
  if (fork === undefined) {
    throw new Error("no fork remote found; set BB_LOCAL_FORK_REMOTE");
  }
  if (
    remotes.some((remote) => remote.name === fork && pushesToUpstream(remote))
  ) {
    throw new Error(
      `fork remote ${fork} points at ${upstreamSlug}; refusing to force-push to upstream`,
    );
  }
  if (fork === upstream) {
    throw new Error(
      `fork and upstream both resolve to ${fork}; set BB_LOCAL_FORK_REMOTE to a different remote`,
    );
  }
  return { fork, upstream };
}

export function resolveForkRemote(remotes, override) {
  const isUpstream = (remote) => remoteSlug(remote.url) === upstreamSlug;
  const pushesToUpstream = (remote) =>
    (remote.pushUrls ?? [remote.url]).some(
      (url) => remoteSlug(url) === upstreamSlug,
    );
  if (override !== undefined) {
    const configured = remotes.find((remote) => remote.name === override);
    if (configured === undefined) {
      throw new Error(`fork remote ${override} is not configured`);
    }
    if (pushesToUpstream(configured)) {
      throw new Error(
        `fork remote ${override} points at ${upstreamSlug}; refusing to force-push to upstream`,
      );
    }
    return configured.name;
  }
  const candidates = remotes.filter((remote) => !isUpstream(remote));
  const fork =
    candidates.find((remote) => remote.name === "fork")?.name ??
    candidates.find((remote) => remote.name === "origin")?.name ??
    candidates[0]?.name;
  if (fork === undefined) {
    throw new Error("no fork remote found; set BB_LOCAL_FORK_REMOTE");
  }
  const configured = candidates.find((remote) => remote.name === fork);
  if (configured !== undefined && pushesToUpstream(configured)) {
    throw new Error(
      `fork remote ${fork} points at ${upstreamSlug}; refusing to force-push to upstream`,
    );
  }
  return fork;
}

export function pushArguments(remoteHead, remote, branch = forkBranch) {
  const args = ["push"];
  if (remoteHead !== null) {
    args.push(`--force-with-lease=refs/heads/${branch}:${remoteHead}`);
  }
  args.push(remote, `HEAD:${branch}`);
  return args;
}

export function backupAppPath(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return path.join(os.homedir(), ".Trash", `bb-local-backup-${stamp}.app`);
}

export function npmEnvironment(environment) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (npmScriptPolicyEnvironmentKeys.has(key.toLowerCase())) {
      delete result[key];
    }
  }
  return result;
}

async function executableRealPath(candidate) {
  try {
    await access(candidate, fsConstants.X_OK);
    if (!(await stat(candidate)).isFile()) return null;
    return realpath(candidate);
  } catch {
    return null;
  }
}

export async function resolveBbCli(
  environment = process.env,
  { applicationsRoot = "/Applications" } = {},
) {
  const explicit = environment.BB_CLI?.trim();
  if (explicit !== undefined && explicit !== "") {
    if (!path.isAbsolute(explicit)) {
      throw new Error(`BB_CLI is not an absolute path: ${explicit}`);
    }
    const resolved = await executableRealPath(explicit);
    if (resolved === null) {
      throw new Error(`BB_CLI is not an existing executable: ${explicit}`);
    }
    return resolved;
  }
  const candidates = [
    ...(environment.PATH ?? "")
      .split(path.delimiter)
      .filter((directory) => directory !== "")
      .map((directory) => path.join(directory, "bb")),
    path.join(
      applicationsRoot,
      "bb.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "bb-app",
      "host-daemon",
      "dist",
      "bb",
    ),
    path.join(
      applicationsRoot,
      "BB.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "bb-app",
      "host-daemon",
      "dist",
      "bb",
    ),
    path.join(
      applicationsRoot,
      "bb Local.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "bb-app",
      "host-daemon",
      "dist",
      "bb",
    ),
    path.join(
      packagedApp,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "bb-app",
      "host-daemon",
      "dist",
      "bb",
    ),
    "/opt/homebrew/bin/bb",
    "/usr/local/bin/bb",
  ];
  for (const candidate of candidates) {
    const resolved = await executableRealPath(candidate);
    if (resolved !== null) return resolved;
  }
  throw new Error(
    "cannot resolve the BB CLI; set BB_CLI to its absolute executable path",
  );
}

export function legacyRuntimeMigration(policy, replacementPolicy = null) {
  for (const field of [
    "projectId",
    "primaryRoot",
    "worktreeRoot",
    "composeProject",
  ]) {
    if (typeof policy?.[field] !== "string" || policy[field].trim() === "") {
      throw new Error(
        `legacy Platform Runtime policy ${field} is missing or invalid`,
      );
    }
  }
  if (!/^proj_[a-zA-Z0-9]+$/u.test(policy.projectId)) {
    throw new Error("legacy Platform Runtime policy projectId is invalid");
  }
  if (
    !path.isAbsolute(policy.primaryRoot) ||
    !path.isAbsolute(policy.worktreeRoot)
  ) {
    throw new Error("legacy Platform Runtime policy roots must be absolute");
  }
  if (replacementPolicy?.projectId === policy.projectId) return null;
  const args = [
    path.join(
      repoRoot,
      "local",
      "plugins",
      "shared-runtime",
      "bin",
      "bb-shared-runtime.mjs",
    ),
    "install",
    "--project-id",
    policy.projectId,
    "--primary-root",
    policy.primaryRoot,
    "--manifest",
    bundledPlatformManifest,
    "--compose-project",
    policy.composeProject,
    "--worktree-root",
    policy.worktreeRoot,
  ];
  if (typeof policy.dockerSocket === "string" && policy.dockerSocket !== "") {
    args.push("--docker-socket", policy.dockerSocket);
  }
  return args;
}

function run(command, args, options = {}) {
  const capture = options.capture === true;
  const environment = { ...process.env, ...(options.env ?? {}) };
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: command === "npm" ? npmEnvironment(environment) : environment,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0 && options.allowFailure !== true) {
    const detail = [result.stdout, result.stderr]
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} exited ${status}${detail === "" ? "" : `\n${detail}`}`,
    );
  }
  return {
    status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function matchingProcessIds(pattern) {
  const result = run("/usr/bin/pgrep", ["-f", pattern], {
    allowFailure: true,
    capture: true,
  });
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`cannot inspect application processes\n${result.stderr}`);
  }
  return result.stdout.split("\n").filter((value) => value !== "");
}

async function waitForProcessExit(pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (matchingProcessIds(pattern).length === 0) return true;
    await delay(100);
  }
  return false;
}

async function waitForLocalServerHealth(label, processPattern) {
  const port = process.env.BB_SERVER_PORT ?? "38886";
  const url = `http://127.0.0.1:${port}/health`;
  let processObserved = false;
  let processChecks = 0;
  let nextProgressAt = Date.now() + 10_000;
  while (true) {
    const processIds = matchingProcessIds(processPattern);
    if (processIds.length > 0) processObserved = true;
    if (processObserved && processIds.length === 0) {
      throw new Error(`${label} exited before becoming healthy at ${url}`);
    }
    processChecks += 1;
    if (!processObserved && processChecks >= 100) {
      throw new Error(`${label} did not launch`);
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const health = await response.json();
        if (
          typeof health === "object" &&
          health !== null &&
          health.ok === true
        ) {
          return;
        }
      }
    } catch {}
    if (Date.now() >= nextProgressAt) {
      console.log(
        `Waiting for ${label} to become healthy; complete any macOS keychain prompt`,
      );
      nextProgressAt = Date.now() + 10_000;
    }
    await delay(100);
  }
}

async function startOfficialApp() {
  if (matchingProcessIds(officialProcessPattern).length === 0) {
    run("/usr/bin/open", ["-na", officialApp]);
  }
  await waitForLocalServerHealth("official BB app", officialProcessPattern);
}

async function stopOfficialApp() {
  if (matchingProcessIds(officialProcessPattern).length === 0) return;
  run(
    "/usr/bin/osascript",
    ["-e", 'tell application id "dev.bb.desktop" to quit'],
    { allowFailure: true, capture: true },
  );
  if (await waitForProcessExit(officialProcessPattern, 10_000)) return;
  run("/usr/bin/pkill", ["-TERM", "-f", officialProcessPattern], {
    allowFailure: true,
  });
  if (!(await waitForProcessExit(officialProcessPattern, 5_000))) {
    throw new Error("official BB app did not stop");
  }
}

async function startLocalApp() {
  run("/usr/bin/open", ["-na", installedApp]);
  await waitForLocalServerHealth("bb Local app", localProcessPattern);
}

function gitOutput(args, options = {}) {
  return run("git", args, { ...options, capture: true });
}

function requireCleanWorktree() {
  const root = gitOutput(["rev-parse", "--show-toplevel"]).stdout;
  if (path.resolve(root) !== repoRoot) {
    throw new Error(`run this command from the bb fork at ${repoRoot}`);
  }
  const branch = gitOutput(["branch", "--show-current"]).stdout;
  if (branch === "") throw new Error("the local fork branch is detached");
  const status = gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).stdout;
  if (status !== "")
    throw new Error(`the local fork worktree is not clean\n${status}`);
  return branch;
}

function remoteHead(forkRemote) {
  const result = gitOutput(
    ["rev-parse", "--verify", `refs/remotes/${forkRemote}/${forkBranch}`],
    { allowFailure: true },
  );
  return result.status === 0 ? result.stdout : null;
}

function configuredRemotes() {
  const seen = new Map();
  for (const line of gitOutput(["remote", "-v"]).stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/u.exec(line.trim());
    if (match !== null && !seen.has(match[1])) seen.set(match[1], match[2]);
  }
  return [...seen].map(([name, url]) => ({
    name,
    pushUrls: gitOutput(["remote", "get-url", "--push", "--all", name])
      .stdout.split("\n")
      .filter((pushUrl) => pushUrl !== ""),
    url,
  }));
}

function activeRemotes() {
  const overrides = {};
  const upstream = process.env.BB_LOCAL_UPSTREAM_REMOTE;
  const fork = process.env.BB_LOCAL_FORK_REMOTE;
  if (upstream !== undefined) overrides.upstream = upstream;
  if (fork !== undefined) overrides.fork = fork;
  return resolveRemoteNames(configuredRemotes(), overrides);
}

function activeForkRemote() {
  return resolveForkRemote(
    configuredRemotes(),
    process.env.BB_LOCAL_FORK_REMOTE,
  );
}

function countCommits(range) {
  return Number.parseInt(gitOutput(["rev-list", "--count", range]).stdout, 10);
}

function ensureLocalAppIsStopped() {
  const result = run(
    "/usr/bin/pgrep",
    ["-f", "^/Applications/bb Local\\.app/Contents/MacOS/bb( |$)"],
    { allowFailure: true, capture: true },
  );
  if (result.status === 0) {
    throw new Error(
      `quit bb Local before installing an update; running process IDs: ${result.stdout}`,
    );
  }
}

function readPluginSource(cli, id) {
  const result = run(cli, ["plugin", "source", id, "--json"], {
    env: { BB_CLI: cli },
    allowFailure: true,
    capture: true,
  });
  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout);
    return typeof parsed.requested === "string" ? parsed.requested : null;
  }
  if (`${result.stdout}\n${result.stderr}`.includes("unknown plugin"))
    return null;
  throw new Error(
    `cannot inspect plugin ${id}\n${result.stderr || result.stdout}`,
  );
}

export async function ensurePluginServerAvailable({
  readSource,
  startOfficial = startOfficialApp,
}) {
  try {
    readSource(localPlugins[0].id);
    return;
  } catch (error) {
    await startOfficial();
  }
  try {
    readSource(localPlugins[0].id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot connect to the official BB server after starting it\n${detail}`,
      { cause: error },
    );
  }
}

function syncLocalPlugin(cli, plugin) {
  const root = path.join(repoRoot, "local", "plugins", plugin.directory);
  const expected = `path:${root}`;
  const requested = readPluginSource(cli, plugin.id);
  const replacements = (plugin.replaces ?? []).filter(
    (id) => readPluginSource(cli, id) !== null,
  );
  for (const step of pluginSyncPlan(
    plugin.id,
    requested,
    expected,
    replacements,
  )) {
    if (step.action === "install") {
      run(cli, ["plugin", "install", "--yes", root], {
        env: { BB_CLI: cli },
      });
    } else {
      run(cli, ["plugin", step.action, step.id], { env: { BB_CLI: cli } });
    }
  }
}

async function migrateLegacyRuntimePolicy(cli) {
  let content;
  try {
    content = await readFile(legacyRuntimePolicyPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const policy = JSON.parse(content);
  const migration = legacyRuntimeMigration(policy);
  const replacementPolicyPath = path.join(
    os.homedir(),
    ".bb",
    "shared-runtime",
    "projects",
    `${policy.projectId}.json`,
  );
  let replacementPolicy = null;
  try {
    replacementPolicy = JSON.parse(
      await readFile(replacementPolicyPath, "utf8"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (legacyRuntimeMigration(policy, replacementPolicy) === null) return;
  run(process.execPath, migration, {
    env: { BB_CLI: cli },
  });
}

function retireLocalPluginReplacements(cli) {
  for (const id of pluginReplacementIds(localPlugins)) {
    if (readPluginSource(cli, id) !== null) {
      run(cli, ["plugin", "remove", id], { env: { BB_CLI: cli } });
    }
    if (readPluginSource(cli, id) !== null) {
      throw new Error(`replaced plugin ${id} is still installed`);
    }
  }
}

async function installPackagedApp() {
  const backup = backupAppPath();
  let hadInstalledApp = false;
  try {
    await access(installedApp);
    hadInstalledApp = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(backup), { recursive: true });
  if (hadInstalledApp) await rename(installedApp, backup);
  try {
    run("ditto", [packagedApp, installedApp]);
    run("codesign", ["--verify", "--deep", "--strict", installedApp]);
    const identifier = run(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Print :CFBundleIdentifier",
        path.join(installedApp, "Contents", "Info.plist"),
      ],
      { capture: true },
    ).stdout;
    if (identifier !== "dev.bb.desktop.local") {
      throw new Error(
        `installed app has unexpected bundle identifier ${identifier}`,
      );
    }
  } catch (error) {
    await rm(installedApp, { recursive: true, force: true });
    if (hadInstalledApp) await rename(backup, installedApp);
    throw error;
  }
  if (hadInstalledApp) console.log(`Previous local app moved to ${backup}`);
}

export async function installAndActivateLocalApp({
  install = installPackagedApp,
  startLocal = startLocalApp,
  stopOfficial = stopOfficialApp,
} = {}) {
  await install();
  await stopOfficial();
  await startLocal();
}

async function updateLocalDesktop(argv) {
  const options = parseLocalUpdateArgs(argv);
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      "the local desktop updater currently supports Apple Silicon macOS only",
    );
  }
  const branch = requireCleanWorktree();
  if (options.install) ensureLocalAppIsStopped();
  let remotes = null;
  let previousForkHead = null;
  let upstreamRef = null;
  let revision = null;
  if (options.current) {
    revision = gitOutput(["rev-parse", "--short", "HEAD"]).stdout;
    console.log(
      `Branch ${branch}: current checkout ${revision} (fetch and rebase skipped)`,
    );
    if (options.check) return;
    if (options.push) {
      if (branch !== forkBranch) {
        throw new Error(
          `current checkout branch ${branch} does not match push target ${forkBranch}; use --skip-push to update from this checkout without rewriting ${forkBranch}`,
        );
      }
      remotes = { fork: activeForkRemote() };
      previousForkHead = remoteHead(remotes.fork);
      if (previousForkHead === null) {
        throw new Error(
          `current checkout mode cannot safely push without refs/remotes/${remotes.fork}/${forkBranch}; fetch the fork first or use --skip-push`,
        );
      }
    }
  } else {
    remotes = activeRemotes();
    run("git", ["fetch", remotes.upstream, upstreamBranch]);
    run("git", ["fetch", remotes.fork, forkBranch]);
    previousForkHead = remoteHead(remotes.fork);
    upstreamRef = `${remotes.upstream}/${upstreamBranch}`;
    const behind = countCommits(`HEAD..${upstreamRef}`);
    const initialPatches = countCommits(`${upstreamRef}..HEAD`);
    console.log(
      `Branch ${branch}: ${behind} upstream commit(s), ${initialPatches} local patch commit(s)`,
    );
    if (options.check) return;
  }
  const cli = options.plugins ? await resolveBbCli() : null;
  if (options.plugins) {
    await ensurePluginServerAvailable({
      readSource: (id) => readPluginSource(cli, id),
    });
  }
  if (upstreamRef !== null) {
    const upstreamIsAncestor = gitOutput(
      ["merge-base", "--is-ancestor", upstreamRef, "HEAD"],
      { allowFailure: true },
    );
    if (upstreamIsAncestor.status !== 0) run("git", ["rebase", upstreamRef]);
  }
  requireCleanWorktree();
  const patches =
    upstreamRef === null ? null : countCommits(`${upstreamRef}..HEAD`);
  run("pnpm", ["install", "--frozen-lockfile"]);
  run("node", [
    "--test",
    "--test-concurrency=1",
    "scripts/update-local-desktop.test.mjs",
  ]);
  run("node", [
    "--test",
    "--test-concurrency=1",
    "local/plugins/shared-runtime/test/manifest.test.mjs",
    "local/plugins/shared-runtime/test/runtime.test.mjs",
  ]);
  run("npm", [
    "ci",
    "--ignore-scripts",
    "--prefix",
    "local/plugins/dir-skills",
  ]);
  run("npm", ["run", "typecheck", "--prefix", "local/plugins/dir-skills"]);
  run("pnpm", ["desktop:local:package"]);
  run("pnpm", ["--filter", "@bb/desktop", "smoke:packaged"], {
    env: { BB_DESKTOP_LOCAL_BUILD: "1" },
  });
  run("codesign", ["--force", "--deep", "--sign", "-", packagedApp]);
  run("codesign", ["--verify", "--deep", "--strict", packagedApp]);
  if (options.plugins) {
    for (const plugin of localPlugins) syncLocalPlugin(cli, plugin);
    await migrateLegacyRuntimePolicy(cli);
  }
  if (options.install) await installAndActivateLocalApp();
  if (options.plugins) retireLocalPluginReplacements(cli);
  if (options.push) {
    if (remotes === null) throw new Error("fork remote was not resolved");
    run("git", pushArguments(previousForkHead, remotes.fork));
  }
  console.log(
    options.current
      ? `bb Local updated from current checkout ${revision}`
      : `bb Local updated from ${upstreamRef} and ${patches} local patch commit(s)`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  updateLocalDesktop(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
