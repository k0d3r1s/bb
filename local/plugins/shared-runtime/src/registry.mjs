import { constants, watch } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { readManifest } from "./manifest.mjs";

export const RUNTIME_ROOT_NAME = "shared-runtime";
const PROJECT_ID_PATTERN = /^proj_[a-zA-Z0-9]+$/;
const HOST_ID_PATTERN = /^host_[a-zA-Z0-9]+$/;

function deny(message) {
  throw new Error(`Shared runtime denied: ${message}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    deny(`${label} is missing or invalid`);
  }
  return value;
}

export function defaultRuntimeRoot() {
  return path.join(homedir(), ".bb", RUNTIME_ROOT_NAME);
}

export function projectsDirectory(runtimeRoot = defaultRuntimeRoot()) {
  return path.join(runtimeRoot, "projects");
}

export function policyPathFor(projectId, runtimeRoot = defaultRuntimeRoot()) {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    deny("project id is invalid");
  }
  return path.join(projectsDirectory(runtimeRoot), `${projectId}.json`);
}

async function assertProtectedDirectory(directory, label) {
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch {
    deny(`${label} is missing`);
  }
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid() ||
    (directoryStat.mode & 0o7777) !== 0o700 ||
    (await realpath(directory)) !== path.resolve(directory)
  ) {
    deny(`${label} has unsafe identity or permissions`);
  }
}

export function validatePolicyDocument(parsed) {
  for (const field of [
    "projectId",
    "trustedHostId",
    "primaryRoot",
    "worktreeRoot",
    "worktreeDirectoryName",
    "gitCommonDir",
    "dockerPath",
    "manifestSha256",
  ]) {
    assertNonEmptyString(parsed[field], `policy ${field}`);
  }
  if (!PROJECT_ID_PATTERN.test(parsed.projectId)) {
    deny("policy projectId is invalid");
  }
  if (!HOST_ID_PATTERN.test(parsed.trustedHostId)) {
    deny("policy trustedHostId is invalid");
  }
  if (
    parsed.worktreeDirectoryName.includes("/") ||
    parsed.worktreeDirectoryName === "." ||
    parsed.worktreeDirectoryName === ".." ||
    parsed.worktreeDirectoryName.includes("\0")
  ) {
    deny("policy worktreeDirectoryName is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(parsed.manifestSha256)) {
    deny("policy manifestSha256 is invalid");
  }
  if (!path.isAbsolute(parsed.primaryRoot) || !path.isAbsolute(parsed.worktreeRoot)) {
    deny("policy roots must be absolute");
  }
  if (!path.isAbsolute(parsed.gitCommonDir) || !path.isAbsolute(parsed.dockerPath)) {
    deny("policy executable and repository paths must be absolute");
  }
  if (
    parsed.dockerSocket !== undefined &&
    parsed.dockerSocket !== null &&
    !path.isAbsolute(assertNonEmptyString(parsed.dockerSocket, "policy Docker socket"))
  ) {
    deny("policy Docker socket must be absolute");
  }
  if (
    parsed.manifestPath !== undefined &&
    parsed.manifestPath !== null &&
    !path.isAbsolute(assertNonEmptyString(parsed.manifestPath, "policy manifest path"))
  ) {
    deny("policy manifest path must be absolute");
  }
  if (
    parsed.composeProject !== undefined &&
    parsed.composeProject !== null &&
    (parsed.composeProject === "null" ||
      !/^[a-zA-Z0-9_.-]+$/.test(
        assertNonEmptyString(parsed.composeProject, "policy Compose project"),
      ))
  ) {
    deny("policy Compose project is invalid");
  }
  if (
    typeof parsed.containers !== "object" ||
    parsed.containers === null ||
    Array.isArray(parsed.containers) ||
    Object.keys(parsed.containers).length === 0
  ) {
    deny("policy containers must map roles to container names");
  }
  for (const [role, name] of Object.entries(parsed.containers)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(role)) {
      deny(`policy container role ${JSON.stringify(role)} is invalid`);
    }
    if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
      deny(`policy container ${role} name is invalid`);
    }
  }
  const hasCodeGraphCommand =
    parsed.codegraphCommand !== null && parsed.codegraphCommand !== undefined;
  const hasCodeGraphRoot =
    parsed.codegraphRoot !== null && parsed.codegraphRoot !== undefined;
  if (hasCodeGraphCommand !== hasCodeGraphRoot) {
    deny("policy CodeGraph command and root must be configured together");
  }
  if (hasCodeGraphCommand) {
    assertNonEmptyString(parsed.codegraphCommand, "policy CodeGraph command");
    assertNonEmptyString(parsed.codegraphRoot, "policy CodeGraph root");
    if (!path.isAbsolute(parsed.codegraphCommand) || !path.isAbsolute(parsed.codegraphRoot)) {
      deny("policy CodeGraph paths must be absolute");
    }
  }
  if (
    parsed.bbCli !== undefined &&
    parsed.bbCli !== null &&
    !path.isAbsolute(assertNonEmptyString(parsed.bbCli, "policy BB CLI"))
  ) {
    deny("policy BB CLI must be absolute");
  }
  return parsed;
}

export async function loadPolicy(policyPath) {
  if (!path.isAbsolute(policyPath) || typeof process.getuid !== "function") {
    deny("policy path or current user identity is invalid");
  }
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    deny("host does not expose no-follow policy opening");
  }
  const projectsRoot = path.dirname(policyPath);
  await assertProtectedDirectory(path.dirname(projectsRoot), "policy runtime directory");
  await assertProtectedDirectory(projectsRoot, "policy projects directory");

  let policyHandle;
  try {
    policyHandle = await open(policyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    deny("policy file is missing or not a regular file");
  }

  let policyContent;
  try {
    const policyStat = await policyHandle.stat();
    if (
      !policyStat.isFile() ||
      policyStat.uid !== process.getuid() ||
      policyStat.nlink !== 1 ||
      (policyStat.mode & 0o7777) !== 0o600
    ) {
      deny("policy file has unsafe identity, links, or permissions");
    }
    policyContent = await policyHandle.readFile("utf8");
  } finally {
    await policyHandle.close();
  }

  const parsed = validatePolicyDocument(JSON.parse(policyContent));
  const expectedName = `${parsed.projectId}.json`;
  if (path.basename(policyPath) !== expectedName) {
    deny(`policy file name must be ${expectedName}`);
  }
  return Object.freeze({ ...parsed, runtimeRoot: path.dirname(projectsRoot) });
}

export async function attachManifest(policy, { readManifestFile = readManifest } = {}) {
  let loaded;
  try {
    loaded = await readManifestFile(policy.primaryRoot, policy.manifestPath);
  } catch (error) {
    return Object.freeze({
      ...policy,
      manifest: null,
      manifestDigest: null,
      manifestError: error?.message ?? String(error),
      manifestStale: true,
    });
  }
  return Object.freeze({
    ...policy,
    manifest: loaded.manifest,
    manifestDigest: loaded.digest,
    manifestError: null,
    manifestStale: loaded.digest !== policy.manifestSha256,
  });
}

export async function loadRegistry(runtimeRoot = defaultRuntimeRoot(), options = {}) {
  const directory = projectsDirectory(runtimeRoot);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { policies: new Map(), problems: [] };
    }
    throw error;
  }
  const policies = new Map();
  const problems = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^proj_[a-zA-Z0-9]+\.json$/.test(entry.name)) {
      continue;
    }
    const policyPath = path.join(directory, entry.name);
    try {
      const policy = await attachManifest(await loadPolicy(policyPath), options);
      policies.set(policy.projectId, policy);
    } catch (error) {
      problems.push({ path: policyPath, message: error?.message ?? String(error) });
    }
  }
  return { policies, problems };
}

export function createRegistry({ runtimeRoot = defaultRuntimeRoot(), log = null, readManifestFile } = {}) {
  let policies = new Map();
  let problems = [];
  let watcher = null;
  let refreshTimer = null;
  let refreshing = null;

  async function refresh() {
    if (refreshing) {
      return refreshing;
    }
    refreshing = (async () => {
      try {
        const loaded = await loadRegistry(runtimeRoot, { readManifestFile });
        policies = loaded.policies;
        problems = loaded.problems;
        for (const problem of problems) {
          log?.warn?.(`shared runtime registry entry skipped: ${problem.path}: ${problem.message}`);
        }
      } finally {
        refreshing = null;
      }
      return policies;
    })();
    return refreshing;
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refresh().catch((error) => log?.warn?.(`shared runtime registry refresh failed: ${error?.message ?? error}`));
    }, 250);
    refreshTimer.unref?.();
  }

  function startWatching() {
    if (watcher) {
      return;
    }
    try {
      watcher = watch(projectsDirectory(runtimeRoot), { persistent: false }, scheduleRefresh);
      watcher.on("error", () => {
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  return {
    async load() {
      await refresh();
      startWatching();
      return policies;
    },
    refresh,
    policyFor(projectId) {
      return policies.get(projectId) ?? null;
    },
    entries() {
      return [...policies.values()];
    },
    problems() {
      return [...problems];
    },
    dispose() {
      clearTimeout(refreshTimer);
      watcher?.close();
      watcher = null;
      policies = new Map();
    },
  };
}
