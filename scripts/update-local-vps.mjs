import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { parse as parseYaml } from "yaml";
import {
  createVpsOperationStore,
  readVpsOperation,
} from "./local-vps-operation.mjs";
import {
  externalPluginCollections,
  gitOutput,
  npmEnvironment,
  parseInstalledPlugins,
  pushArguments,
  resolveExternalPlugins,
  resolveRemoteNames,
  syncCollectionPlugin,
  unlistedCollectionPluginIds,
} from "./update-local-desktop.mjs";
import { canonicalizeExistingDataDir } from "./install-local-vps-service.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const upstreamBranch = process.env.BB_LOCAL_UPSTREAM_BRANCH ?? "main";
const forkBranch = process.env.BB_LOCAL_FORK_BRANCH ?? "main";
const defaultTtlMs = 300_000;
export const VPS_NODE_ENGINE = "^22.19.0";

function healthUrl() {
  const port = process.env.BB_SERVER_PORT ?? "38886";
  if (!/^\d+$/u.test(port)) throw new Error("BB_SERVER_PORT must be numeric");
  return `http://127.0.0.1:${port}/health`;
}

export async function resolveVpsDataDir(
  options,
  homeDir,
  environment = process.env,
) {
  const requestedDataDirValue = options.dataDir ?? environment.BB_DATA_DIR;
  const requestedDataDir = requestedDataDirValue
    ? await canonicalizeExistingDataDir(requestedDataDirValue)
    : undefined;
  let serviceDataDir;
  try {
    const content = await readFile(
      path.join(homeDir, ".config", "bb-local", "environment"),
      "utf8",
    );
    const entry = content
      .split("\n")
      .find((line) => line.startsWith("BB_DATA_DIR="));
    if (entry)
      serviceDataDir = await canonicalizeExistingDataDir(
        parseStoredDataDir(entry.slice("BB_DATA_DIR=".length)),
      );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (
    requestedDataDir &&
    serviceDataDir &&
    path.normalize(requestedDataDir) !== path.normalize(serviceDataDir)
  ) {
    throw new Error(
      `requested BB data directory ${requestedDataDir} does not match the installed service directory ${serviceDataDir}; rerun the service installer to change it`,
    );
  }
  if (requestedDataDir) return requestedDataDir;
  if (serviceDataDir) return serviceDataDir;
  return canonicalizeExistingDataDir(path.join(homeDir, ".bb"));
}

export function parseStoredDataDir(value) {
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "string") throw new Error("BB_DATA_DIR is invalid");
    return parsed;
  }
  return value;
}

export function satisfiesNodeEngine(version, engine) {
  const parsedVersion = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!parsedVersion) return false;
  const actual = parsedVersion.slice(1).map(Number);
  return engine.split("||").some((rawRange) => {
    const range = /^(\^|>=)(\d+)\.(\d+)\.(\d+)$/u.exec(rawRange.trim());
    if (!range) return false;
    const minimum = range.slice(2).map(Number);
    const atLeastMinimum =
      actual.some(
        (part, index) =>
          part > minimum[index] &&
          actual
            .slice(0, index)
            .every((value, prefix) => value === minimum[prefix]),
      ) || actual.every((part, index) => part === minimum[index]);
    return atLeastMinimum && (range[1] === ">=" || actual[0] === minimum[0]);
  });
}

export function assertSupportedVpsNode(version) {
  if (!satisfiesNodeEngine(version, VPS_NODE_ENGINE)) {
    throw new Error(
      `Node ${version} must satisfy ${VPS_NODE_ENGINE} for Linux arm64 VPS releases`,
    );
  }
}

export function matchesPackageManagerVersion(actualVersion, packageManager) {
  const required = /^pnpm@(\d+)\.(\d+)\.(\d+)$/u.exec(packageManager);
  const actual = /^(\d+)\.(\d+)\.(\d+)$/u.exec(actualVersion);
  return Boolean(
    required &&
    actual &&
    required.slice(1).join(".") === actual.slice(1).join("."),
  );
}

async function validateToolchain(releaseRoot) {
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const appPackageJson = JSON.parse(
    await readFile(
      path.join(repoRoot, "packages", "bb-app", "package.json"),
      "utf8",
    ),
  );
  const nodeEngines = [packageJson.engines?.node, appPackageJson.engines?.node];
  if (
    nodeEngines.some(
      (engine) =>
        typeof engine !== "string" ||
        !satisfiesNodeEngine(process.versions.node, engine),
    )
  ) {
    throw new Error(
      `Node ${process.versions.node} must satisfy ${nodeEngines.join(" and ")}`,
    );
  }
  assertSupportedVpsNode(process.versions.node);
  if (
    !matchesPackageManagerVersion(
      run("pnpm", ["--version"], { capture: true }).stdout,
      packageJson.packageManager ?? "",
    )
  ) {
    throw new Error(`pnpm must exactly match ${packageJson.packageManager}`);
  }
  await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
  const availableKb = Number(
    run("df", ["-Pk", releaseRoot], { capture: true })
      .stdout.split("\n")
      .at(-1)
      ?.trim()
      .split(/\s+/u)
      .at(-3),
  );
  if (!Number.isFinite(availableKb) || availableKb < 2 * 1024 * 1024) {
    throw new Error("at least 2 GiB of writable release storage is required");
  }
}

export const VPS_UPDATE_EXIT_CODES = Object.freeze({
  success: 0,
  usage: 2,
  unsupported: 3,
  contention: 4,
  activeWork: 5,
  transport: 6,
  candidateRolledBack: 7,
  rollbackFailed: 8,
  releaseFailed: 9,
  pushFailed: 10,
});

export class VpsUpdateError extends Error {
  constructor(message, exitCode, cause, operationPhase = null) {
    super(message, { cause });
    this.name = "VpsUpdateError";
    this.exitCode = exitCode;
    this.operationPhase = operationPhase;
  }
}

export function asVpsRecoveryError(error) {
  if (
    error instanceof VpsUpdateError &&
    error.exitCode === VPS_UPDATE_EXIT_CODES.releaseFailed
  ) {
    return error;
  }
  return new VpsUpdateError(
    "VPS recovery failed",
    VPS_UPDATE_EXIT_CODES.releaseFailed,
    error,
  );
}

export function assertOperationDataDir(record, dataDir) {
  if (record.dataDir !== dataDir) {
    throw new Error(
      `operation data directory ${String(record.dataDir)} does not match the selected service directory ${dataDir}`,
    );
  }
}

export function assertSupportedHost(platform, architecture) {
  if (platform !== "linux" || architecture !== "arm64") {
    throw new VpsUpdateError(
      "the local VPS updater supports Linux arm64 only",
      VPS_UPDATE_EXIT_CODES.unsupported,
    );
  }
}

export function assertCandidateNativeArchitecture(releaseDir, execute = run) {
  const nativeAddon = path.join(
    releaseDir,
    "packages",
    "bb-app",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  const architecture = execute("file", [nativeAddon], { capture: true }).stdout;
  if (!/ARM aarch64|ARM64/u.test(architecture)) {
    throw new Error(
      `candidate native dependency is not ARM64: ${architecture}`,
    );
  }
}

export function parseVpsUpdateArgs(argv) {
  const options = {
    allowActiveWork: false,
    bootstrap: false,
    check: false,
    dataDir: undefined,
    plugins: true,
    push: true,
    recover: undefined,
    stageOnly: false,
    status: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--allow-active-work") options.allowActiveWork = true;
    else if (argument === "--bootstrap") options.bootstrap = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--skip-plugins") options.plugins = false;
    else if (argument === "--skip-push") options.push = false;
    else if (argument === "--stage-only") options.stageOnly = true;
    else if (argument === "--data-dir") {
      const value = argv[index + 1];
      index += 1;
      if (!value || !path.isAbsolute(value))
        throw new Error("--data-dir requires an absolute path");
      options.dataDir = value;
    } else if (argument === "--recover") {
      const value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith("--"))
        throw new Error("--recover requires an operation ID");
      options.recover = value;
    } else if (argument === "--status") {
      const value = argv[index + 1];
      if (value && !value.startsWith("--")) {
        options.status = value;
        index += 1;
      } else {
        options.status = "latest";
      }
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  const modes = [
    options.check,
    options.stageOnly,
    options.bootstrap,
    options.recover !== undefined,
    options.status !== undefined,
  ].filter(Boolean);
  if (modes.length > 1)
    throw new Error(
      "--check, --stage-only, --bootstrap, --recover, and --status are mutually exclusive",
    );
  return options;
}

export function buildSandboxCommand({
  operationId,
  candidateDir,
  cacheDir,
  dataDir,
  toolPaths = ["/usr"],
  network = false,
  userRuntimeDir = `/run/user/${typeof process.getuid === "function" ? process.getuid() : "0"}`,
  command,
}) {
  for (const value of [
    candidateDir,
    cacheDir,
    dataDir,
    userRuntimeDir,
    ...toolPaths,
  ]) {
    if (!path.isAbsolute(value) || /[\r\n]/u.test(value))
      throw new Error("sandbox paths must be absolute single-line paths");
  }
  return {
    executable: "systemd-run",
    args: [
      "--user",
      "--wait",
      "--pipe",
      "--collect",
      `--unit=bb-local-build-${operationId.replace(/[^a-zA-Z0-9_.-]/gu, "-")}`,
      "--property",
      "ProtectSystem=strict",
      "--property",
      "ProtectHome=read-only",
      "--property",
      "PrivateTmp=yes",
      "--property",
      "PrivateUsers=yes",
      "--property",
      "PrivateDevices=yes",
      "--property",
      `PrivateNetwork=${network ? "no" : "yes"}`,
      "--property",
      "ProtectProc=ptraceable",
      "--property",
      "ProcSubset=pid",
      "--property",
      "ProtectControlGroups=yes",
      "--property",
      "ProtectKernelModules=yes",
      "--property",
      "ProtectKernelTunables=yes",
      "--property",
      "LockPersonality=yes",
      "--property",
      "RestrictNamespaces=yes",
      "--property",
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "--property",
      "NoNewPrivileges=yes",
      "--property",
      "RestrictSUIDSGID=yes",
      "--property",
      "UMask=0077",
      "--property",
      `ReadWritePaths=${JSON.stringify(candidateDir)} ${JSON.stringify(cacheDir)}`,
      "--property",
      `BindPaths=${JSON.stringify(candidateDir)} ${JSON.stringify(cacheDir)}`,
      "--property",
      `BindReadOnlyPaths=${toolPaths.map((toolPath) => JSON.stringify(toolPath)).join(" ")}`,
      "--property",
      `InaccessiblePaths=${[
        dataDir,
        userRuntimeDir,
        "-/run/containerd",
        "-/run/dbus",
        "-/run/docker.sock",
        "-/run/podman",
        "-/var/run/docker.sock",
        "-/var/run/podman",
      ]
        .map((sandboxPath) => JSON.stringify(sandboxPath))
        .join(" ")}`,
      `--working-directory=${candidateDir}`,
      "--",
      "/usr/bin/env",
      "-i",
      `PATH=${toolPaths.flatMap((toolPath) => [toolPath, path.join(toolPath, "bin")]).join(":")}:/usr/local/bin:/usr/bin:/bin`,
      `PNPM_HOME=${path.join(cacheDir, "pnpm-home")}`,
      `npm_config_cache=${path.join(cacheDir, "npm-cache")}`,
      "npm_config_child_concurrency=1",
      `npm_config_nodedir=${toolPaths[0]}`,
      "npm_config_jobs=1",
      `TURBO_CACHE_DIR=${path.join(cacheDir, "turbo-cache")}`,
      "TURBO_CONCURRENCY=1",
      ...command,
    ],
  };
}

export async function validateCandidateFetchInputs(candidateDir) {
  const rejectedConfigPaths = [".npmrc", ".pnpmfile.cjs"];
  for (const relativePath of rejectedConfigPaths) {
    try {
      await lstat(path.join(candidateDir, relativePath));
      throw new Error(
        `candidate package-manager config is forbidden: ${relativePath}`,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const pnpmLock = parseYaml(
    await readFile(path.join(candidateDir, "pnpm-lock.yaml"), "utf8"),
    { maxAliasCount: 0, merge: false },
  );
  validatePnpmLockValue(pnpmLock);
}

function validatePnpmLockValue(value) {
  if (Array.isArray(value)) {
    for (const entry of value) validatePnpmLockValue(entry);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "resolution") {
      if (
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry) ||
        Object.keys(entry).length !== 1 ||
        typeof entry.integrity !== "string" ||
        !/^sha512-[a-zA-Z0-9+/]+={0,2}$/u.test(entry.integrity)
      ) {
        throw new Error(
          "pnpm lock contains a non-registry dependency resolution",
        );
      }
    }
    if (
      (key === "specifier" || key === "version") &&
      typeof entry === "string" &&
      /^(?:git(?:\+[^:]+)?:|git@|github:|gitlab:|bitbucket:|https?:|ssh:|file:)/iu.test(
        entry,
      )
    ) {
      throw new Error("pnpm lock contains a non-registry dependency");
    }
    validatePnpmLockValue(entry);
  }
}

export function candidateBuildCommands(
  dataDir,
  cacheDir = "/tmp/bb-build-cache",
) {
  if (!path.isAbsolute(dataDir) || /[\r\n]/u.test(dataDir)) {
    throw new Error("BB data directory must be an absolute single-line path");
  }
  const npmConfigPath = path.join(cacheDir, "empty-npmrc");
  return [
    ["/usr/bin/test", "!", "-r", path.join(dataDir, "bb.db")],
    ["/usr/bin/test", "!", "-r", path.join(dataDir, "admin", "capability")],
    ["/usr/bin/test", "!", "-r", path.join(dataDir, "admin", "operations")],
    ["/usr/bin/touch", npmConfigPath],
    [
      "pnpm",
      "fetch",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--store-dir",
      path.join(cacheDir, "pnpm-store"),
    ],
    [
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--offline",
      "--store-dir",
      path.join(cacheDir, "pnpm-store"),
    ],
    [
      "pnpm",
      "--filter",
      "bb-app",
      "rebuild",
      "better-sqlite3",
      "--store-dir",
      path.join(cacheDir, "pnpm-store"),
    ],
    [
      "node",
      "--test",
      "--test-concurrency=1",
      "scripts/update-local-vps.test.mjs",
    ],
    [
      "pnpm",
      "exec",
      "turbo",
      "run",
      "build",
      "--concurrency=1",
      "--filter=bb-app",
    ],
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--install-links=true",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      "--prefix",
      path.join(cacheDir, "bb-app-smoke-warm"),
      "--cache",
      path.join(cacheDir, "npm-cache"),
      "--userconfig=/dev/null",
      `--globalconfig=${npmConfigPath}`,
      "--registry=https://registry.npmjs.org",
      "--git=/usr/bin/false",
      "./packages/bb-app",
    ],
    [
      "/usr/bin/env",
      "BB_APP_SMOKE_USE_WORKSPACE_ARTIFACTS=true",
      "npm_config_offline=true",
      "npm_config_prefer_offline=true",
      "npm_config_fetch_retries=0",
      "npm_config_userconfig=/dev/null",
      `npm_config_globalconfig=${npmConfigPath}`,
      "npm_config_registry=https://registry.npmjs.org",
      "npm_config_git=/usr/bin/false",
      "pnpm",
      "--filter",
      "bb-app",
      "smoke:tarball",
    ],
  ];
}

export function candidateCommandNeedsNetwork(command) {
  return (
    (command[0] === "pnpm" && command[1] === "fetch") ||
    (command[0] === "npm" &&
      command[1] === "install" &&
      command.includes("--ignore-scripts"))
  );
}

function activeEntries(response) {
  return Object.entries(response.activity?.activeByKind ?? {})
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
}

async function confirmActiveWork(entries) {
  const summary = entries.map(([kind, count]) => `${kind}=${count}`).join(",");
  const expected = `ALLOW ACTIVE WORK ${summary}`;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return false;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await prompt.question(
      `Active work remains: ${summary}\nType ${expected} to continue: `,
    );
    return answer === expected;
  } finally {
    prompt.close();
  }
}

export async function activateVpsRelease(input, { admin, runtime }) {
  let acquired;
  try {
    acquired = await admin.acquire({
      operationId: input.operationId,
      ownerSecret: input.ownerSecret,
      reason: input.reason,
      ttlMs: input.ttlMs,
    });
  } catch (error) {
    throw new VpsUpdateError(
      "maintenance acquisition or its ordered daemon barrier failed",
      VPS_UPDATE_EXIT_CODES.transport,
      error,
      "barrier-failed",
    );
  }
  if (!acquired.lease || acquired.lease.phase !== "draining") {
    throw new VpsUpdateError(
      "maintenance acquisition did not return a draining lease",
      VPS_UPDATE_EXIT_CODES.transport,
    );
  }
  if (acquired.barrier.some((host) => host.state !== "quiesced")) {
    throw new VpsUpdateError(
      "not every daemon acknowledged the ordered quiesce barrier",
      VPS_UPDATE_EXIT_CODES.transport,
    );
  }
  const active = activeEntries(acquired);
  const activeWorkAccepted =
    active.length > 0 &&
    input.allowActiveWork &&
    (await runtime.confirmActiveWork?.(active)) === true;
  if (active.length > 0 && !activeWorkAccepted) {
    try {
      await admin.release({
        operationId: input.operationId,
        ownerSecret: input.ownerSecret,
        resolution: "force-aborted",
      });
    } catch (error) {
      throw new VpsUpdateError(
        "active work blocked activation and maintenance release failed",
        VPS_UPDATE_EXIT_CODES.releaseFailed,
        error,
      );
    }
    throw new VpsUpdateError(
      `active work remains after the barrier: ${active.map(([kind, count]) => `${kind}=${count}`).join(", ")}${input.allowActiveWork ? "; exact operator confirmation was not provided" : ""}`,
      VPS_UPDATE_EXIT_CODES.activeWork,
    );
  }
  await runtime.reportPhase?.("sealing");
  let sealResult;
  try {
    sealResult = await admin.seal({
      operationId: input.operationId,
      ownerSecret: input.ownerSecret,
      candidateRelease: input.candidateRelease,
      previousRelease: input.previousRelease,
      allowActiveWork: input.allowActiveWork,
    });
  } catch (error) {
    throw new VpsUpdateError(
      "maintenance could not reach the durable sealed phase; service restart was not attempted",
      VPS_UPDATE_EXIT_CODES.transport,
      error,
      "barrier-failed",
    );
  }
  if (sealResult.lease?.phase !== "sealed") {
    throw new VpsUpdateError(
      "maintenance seal did not reach the durable sealed phase; service restart was not attempted",
      VPS_UPDATE_EXIT_CODES.transport,
      undefined,
      "barrier-failed",
    );
  }
  await runtime.reportPhase?.("sealed");

  let maintenancePhase = "sealed";
  let candidateFailure;
  try {
    await admin.transition({
      operationId: input.operationId,
      ownerSecret: input.ownerSecret,
      expectedPhase: "sealed",
      phase: "activating",
    });
    maintenancePhase = "activating";
    await runtime.reportPhase?.("activating");
    await runtime.switchCurrent(input.candidateRelease);
    await runtime.restart();
    await runtime.waitForAdmin(input.candidateRelease);
    await admin.transition({
      operationId: input.operationId,
      ownerSecret: input.ownerSecret,
      expectedPhase: "activating",
      phase: "verifying",
    });
    maintenancePhase = "verifying";
    await runtime.reportPhase?.("verifying");
    await runtime.verify(
      input.candidateRelease,
      acquired.barrier.map((host) => host.hostId),
    );
    if (input.plugins) {
      await runtime.reportPhase?.("plugins");
      await runtime.installPlugins();
    }
  } catch (error) {
    candidateFailure = error;
  }

  if (candidateFailure !== undefined) {
    try {
      await runtime.reportPhase?.("rolling-back");
      await runtime.switchCurrent(input.previousRelease);
      await runtime.restart();
      await runtime.verify(
        input.previousRelease,
        acquired.barrier.map((host) => host.hostId),
      );
      if (
        candidateFailure instanceof VpsUpdateError &&
        candidateFailure.exitCode === VPS_UPDATE_EXIT_CODES.rollbackFailed
      ) {
        throw candidateFailure;
      }
      await admin.transition({
        operationId: input.operationId,
        ownerSecret: input.ownerSecret,
        expectedPhase: maintenancePhase,
        phase: "rolling-back",
      });
      await runtime.reportPhase?.("rollback-verified");
    } catch (rollbackError) {
      try {
        let retainedPhase = (await admin.status()).lease?.phase;
        if (retainedPhase === maintenancePhase) {
          await admin.transition({
            operationId: input.operationId,
            ownerSecret: input.ownerSecret,
            expectedPhase: retainedPhase,
            phase: "rolling-back",
          });
          retainedPhase = "rolling-back";
        }
        if (retainedPhase === "rolling-back") {
          await admin.transition({
            operationId: input.operationId,
            ownerSecret: input.ownerSecret,
            expectedPhase: "rolling-back",
            phase: "rollback-failed",
          });
        }
      } catch {}
      throw new VpsUpdateError(
        "candidate and rollback verification failed; fail-closed maintenance remains sealed",
        VPS_UPDATE_EXIT_CODES.rollbackFailed,
        rollbackError,
      );
    }
    try {
      await runtime.reportPhase?.("releasing");
      await admin.release({
        operationId: input.operationId,
        ownerSecret: input.ownerSecret,
        resolution: "rolled-back",
      });
    } catch (error) {
      throw new VpsUpdateError(
        "rollback was verified but maintenance release failed",
        VPS_UPDATE_EXIT_CODES.releaseFailed,
        error,
      );
    }
    throw new VpsUpdateError(
      "candidate verification failed; previous release was restored and verified",
      VPS_UPDATE_EXIT_CODES.candidateRolledBack,
      candidateFailure,
    );
  }

  try {
    await runtime.reportPhase?.("releasing");
    await admin.release({
      operationId: input.operationId,
      ownerSecret: input.ownerSecret,
      resolution: "completed",
    });
  } catch (error) {
    throw new VpsUpdateError(
      "candidate is healthy but maintenance release failed",
      VPS_UPDATE_EXIT_CODES.releaseFailed,
      error,
    );
  }
  return { activated: true };
}

export async function activateBootstrapRelease(input, { runtime }) {
  try {
    await runtime.reportPhase("activating");
    await runtime.switchCurrent(input.candidateRelease);
    await runtime.start();
    await runtime.reportPhase("verifying");
    await runtime.verify(input.candidateRelease);
  } catch (error) {
    let restorationError;
    try {
      if (input.previousRelease !== "none") {
        await runtime.restorePrevious(input.previousRelease);
      } else {
        await runtime.restoreInactive();
      }
    } catch (caught) {
      restorationError = caught;
    }
    let reportingError;
    try {
      await runtime.reportFailure(restorationError ?? error);
    } catch (caught) {
      reportingError = caught;
    }
    if (restorationError !== undefined) {
      throw new VpsUpdateError(
        "bootstrap candidate and rollback both failed; recovery is required",
        VPS_UPDATE_EXIT_CODES.rollbackFailed,
        new AggregateError(
          [error, restorationError, reportingError].filter(
            (failure) => failure !== undefined,
          ),
          "bootstrap activation and rollback failures",
        ),
      );
    }
    if (reportingError !== undefined) {
      throw new VpsUpdateError(
        "bootstrap candidate was restored but its failure record could not be persisted",
        VPS_UPDATE_EXIT_CODES.releaseFailed,
        reportingError,
      );
    }
    throw new VpsUpdateError(
      "bootstrap candidate failed; the previous service state was restored",
      VPS_UPDATE_EXIT_CODES.candidateRolledBack,
      error,
    );
  }
}

function run(command, args, options = {}) {
  const environment = { ...process.env, ...(options.env ?? {}) };
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: command === "npm" ? npmEnvironment(environment) : environment,
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeoutMs,
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    const details = [result.stdout, result.stderr]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n");
    throw new Error(
      `${command} ${args.join(" ")} exited ${status}${details ? `\n${details.trim()}` : ""}`,
    );
  }
  return {
    status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
  };
}

function readVpsPluginSource(cli, id, execute) {
  const result = execute(cli, ["plugin", "source", id, "--json"], {
    allowFailure: true,
    capture: true,
  });
  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout);
    if (typeof parsed.requested !== "string") {
      throw new Error(`plugin ${id} returned an invalid requested source`);
    }
    return {
      requested: parsed.requested,
      subdirectory:
        typeof parsed.subdirectory === "string"
          ? parsed.subdirectory
          : undefined,
      tagPrefix:
        typeof parsed.tagPrefix === "string" ? parsed.tagPrefix : undefined,
    };
  }
  if (`${result.stdout}\n${result.stderr}`.includes("unknown plugin")) {
    return null;
  }
  throw new Error(
    `cannot inspect plugin ${id}\n${result.stderr || result.stdout}`,
  );
}

function installVpsPluginSource(cli, source, execute) {
  const args = ["plugin", "install", "--yes"];
  if (source.subdirectory !== undefined) {
    args.push("--subdirectory", source.subdirectory);
  }
  if (source.tagPrefix !== undefined) {
    args.push("--tag-prefix", source.tagPrefix);
  }
  args.push(source.requested);
  execute(cli, args);
}

function restoreVpsPluginSource(cli, id, source, execute) {
  const current = readVpsPluginSource(cli, id, execute);
  if (current !== null) execute(cli, ["plugin", "remove", id]);
  if (source !== null) installVpsPluginSource(cli, source, execute);
  const restored = readVpsPluginSource(cli, id, execute);
  if (JSON.stringify(restored) !== JSON.stringify(source)) {
    throw new Error(`plugin ${id} source restoration did not persist`);
  }
}

export function syncVpsPlugins({ cli, plugins, collections }, execute = run) {
  const readSource = (id) => readVpsPluginSource(cli, id, execute);
  const unlisted = unlistedCollectionPluginIds(
    parseInstalledPlugins(
      execute(cli, ["plugin", "list", "--json"], { capture: true }).stdout,
    ),
    collections,
    plugins,
  );
  const snapshots = new Map(
    [...plugins.map((plugin) => plugin.id), ...unlisted].map((id) => [
      id,
      readSource(id),
    ]),
  );
  const touched = [];
  try {
    for (const plugin of plugins) {
      touched.push(plugin.id);
      syncCollectionPlugin(
        plugin,
        snapshots.get(plugin.id)?.requested ?? null,
        { command: (args) => execute(cli, args), readSource },
      );
    }
    if (unlisted.length > 0) {
      console.log(
        `Removing ${unlisted.length} external plugin(s) no longer in the collection manifest; their settings, secrets, and schedules are dropped: ${unlisted.join(", ")}`,
      );
    }
    for (const id of unlisted) {
      touched.push(id);
      execute(cli, ["plugin", "remove", id]);
    }
  } catch (error) {
    const restorationErrors = [];
    for (const id of touched.toReversed()) {
      try {
        restoreVpsPluginSource(cli, id, snapshots.get(id), execute);
      } catch (restorationError) {
        restorationErrors.push(restorationError);
      }
    }
    if (restorationErrors.length > 0) {
      throw new VpsUpdateError(
        "plugin synchronization and source restoration both failed",
        VPS_UPDATE_EXIT_CODES.rollbackFailed,
        new AggregateError(
          [error, ...restorationErrors],
          "plugin synchronization rollback failures",
        ),
        "rollback-failed",
      );
    }
    throw error;
  }
}

function configuredRemotes() {
  const output = run("git", ["remote", "-v"], { capture: true }).stdout;
  const seen = new Map();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/u.exec(line.trim());
    if (match && !seen.has(match[1])) seen.set(match[1], match[2]);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

function activeRemotes() {
  return resolveRemoteNames(configuredRemotes(), {
    ...(process.env.BB_LOCAL_UPSTREAM_REMOTE
      ? { upstream: process.env.BB_LOCAL_UPSTREAM_REMOTE }
      : {}),
    ...(process.env.BB_LOCAL_FORK_REMOTE
      ? { fork: process.env.BB_LOCAL_FORK_REMOTE }
      : {}),
  });
}

function requireCleanPrimary() {
  const root = path.resolve(gitOutput(["rev-parse", "--show-toplevel"]));
  if (root !== repoRoot) throw new Error(`run this command from ${repoRoot}`);
  const branch = gitOutput(["branch", "--show-current"]);
  if (!branch) throw new Error("the primary checkout is detached");
  const status = gitOutput([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status) throw new Error(`the primary checkout is not clean\n${status}`);
  return branch;
}

export function assertPushBranch(branch, targetBranch, push) {
  if (push && branch !== targetBranch) {
    throw new Error(
      `refusing to push branch ${branch} over ${targetBranch}; check out ${targetBranch} or use --skip-push`,
    );
  }
}

export function createMaintenanceAdminClient(dataDir, ownerSecret) {
  const socketPath = path.join(dataDir, "admin", "maintenance.sock");
  const capabilityPath = path.join(dataDir, "admin", "capability");
  const invoke = async (requestPath, body) => {
    const capability = (await readFile(capabilityPath, "utf8")).trim();
    if (!capability) throw new Error("admin capability file is empty");
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          socketPath,
          path: requestPath,
          method: encodedBody === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${capability}`,
            ...(encodedBody === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(encodedBody),
                }),
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const status = response.statusCode ?? 500;
              if (status < 200 || status >= 300) {
                reject(
                  new Error(
                    `maintenance request failed with HTTP ${status}: ${typeof value?.message === "string" ? value.message : "unknown error"}`,
                  ),
                );
                return;
              }
              resolve(value);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.setTimeout(35_000, () =>
        outgoing.destroy(new Error("maintenance request timed out")),
      );
      outgoing.once("error", reject);
      if (encodedBody !== undefined) outgoing.write(encodedBody);
      outgoing.end();
    });
  };
  return {
    acquire: (input) =>
      invoke("/maintenance/acquisitions", {
        operationId: input.operationId,
        ownerSecret,
        reason: input.reason,
        ttlMs: input.ttlMs,
      }),
    seal: (input) => invoke("/maintenance/seal", { ...input, ownerSecret }),
    transition: (input) =>
      invoke("/maintenance/transition", { ...input, ownerSecret }),
    release: (input) =>
      invoke("/maintenance/release", { ...input, ownerSecret }),
    recover: (operationId) =>
      invoke("/maintenance/recover", { operationId, ownerSecret }),
    identity: () => invoke("/identity"),
    status: () => invoke("/maintenance"),
  };
}

export function assertRuntimeReleaseIdentity(
  identity,
  expectedRelease,
  expectedHostIds = [],
  requireConnectedHost = false,
) {
  if (identity.service !== "bb-maintenance" || identity.protocolVersion !== 2) {
    throw new Error(
      "running service does not implement maintenance protocol 2",
    );
  }
  if (identity.releaseIdentity !== expectedRelease) {
    throw new Error(
      `running release identity ${identity.releaseIdentity} does not match ${expectedRelease}`,
    );
  }
  if (
    !Array.isArray(identity.connectedHostIds) ||
    !identity.connectedHostIds.every((hostId) => typeof hostId === "string")
  ) {
    throw new Error("maintenance identity has invalid connected host IDs");
  }
  const connectedHostIds = new Set(identity.connectedHostIds);
  const missingHostIds = expectedHostIds.filter(
    (hostId) => !connectedHostIds.has(hostId),
  );
  if (missingHostIds.length > 0) {
    throw new Error(
      `running release is missing expected host daemons: ${missingHostIds.join(", ")}`,
    );
  }
  if (requireConnectedHost && connectedHostIds.size === 0) {
    throw new Error("running release has no connected host daemon");
  }
}

export function assertServiceProcessRelease(actualRelease, expectedRelease) {
  if (actualRelease !== expectedRelease) {
    throw new Error(
      `service process release ${actualRelease} does not match ${expectedRelease}`,
    );
  }
}

export function assertCurrentReleaseTarget(actualRelease, expectedRelease) {
  if (actualRelease !== expectedRelease) {
    throw new Error(
      `current release target ${actualRelease} does not match ${expectedRelease}`,
    );
  }
}

export async function waitForServiceProcessRelease(
  expectedRelease,
  {
    execute = run,
    resolveRealpath = realpath,
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now = Date.now,
    deadlineMs = 10_000,
  } = {},
) {
  const deadline = now() + deadlineMs;
  let lastError;
  while (true) {
    const mainPid = execute(
      "systemctl",
      [
        "--user",
        "show",
        "bb-local.service",
        "--property",
        "MainPID",
        "--value",
      ],
      { capture: true, timeoutMs: 10_000 },
    ).stdout;
    if (/^[1-9]\d*$/u.test(mainPid)) {
      try {
        assertServiceProcessRelease(
          await resolveRealpath(path.join("/proc", mainPid, "cwd")),
          expectedRelease,
        );
        return;
      } catch (error) {
        lastError = error;
      }
    } else {
      lastError = new Error(
        `bb-local.service has no running main process: ${mainPid}`,
      );
    }
    if (now() >= deadline) throw lastError;
    await wait(50);
  }
}

async function verifyServiceProcessRelease(expectedRelease) {
  await waitForServiceProcessRelease(expectedRelease);
}

async function waitForRuntimeIdentity(
  admin,
  expectedRelease,
  expectedHostIds = [],
  requireConnectedHost = false,
  deadlineMs = 30_000,
) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const identity = await admin.identity();
      assertRuntimeReleaseIdentity(
        identity,
        expectedRelease,
        expectedHostIds,
        requireConnectedHost,
      );
      return identity;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `runtime identity verification timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function atomicCurrentSwitch(currentPath, target) {
  const temporary = `${currentPath}.next-${process.pid}`;
  await rm(temporary, { force: true });
  await symlink(target, temporary);
  await rename(temporary, currentPath);
}

export async function validateOwnedVpsRelease(releaseRoot, target) {
  const resolvedRoot = path.resolve(releaseRoot);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith("..") || relative.includes(path.sep)) {
    throw new Error(`release is outside the owned release root: ${target}`);
  }
  const releaseStat = await lstat(resolvedTarget);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()) {
    throw new Error(`release is not an owned directory: ${target}`);
  }
  const canonicalTarget = path.join(await realpath(resolvedRoot), relative);
  if ((await realpath(resolvedTarget)) !== canonicalTarget) {
    throw new Error(`release resolves outside its owned path: ${target}`);
  }
  const marker = JSON.parse(
    await readFile(path.join(resolvedTarget, ".bb-vps-release.json"), "utf8"),
  );
  if (
    marker.complete !== true ||
    marker.commit !== path.basename(resolvedTarget)
  ) {
    throw new Error(`release completion marker does not match: ${target}`);
  }
  return resolvedTarget;
}

async function waitForHealth(url, deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok && (await response.json()).ok === true) return;
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `health verification timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function makeReleaseReadOnly(releaseDir) {
  run("chmod", ["-R", "a-w", releaseDir]);
  const marker = JSON.parse(
    await readFile(path.join(releaseDir, ".bb-vps-release.json"), "utf8"),
  );
  if (marker.complete !== true)
    throw new Error("release completion marker is invalid");
}

async function assertBootstrapInactive() {
  const service = run(
    "systemctl",
    ["--user", "is-active", "--quiet", "bb-local.service"],
    { allowFailure: true },
  );
  if (service.status === 0) {
    throw new VpsUpdateError(
      "--bootstrap requires bb-local.service to be inactive",
      VPS_UPDATE_EXIT_CODES.unsupported,
    );
  }
  const processes = run(
    "pgrep",
    ["-f", "packages/bb-app/dist/bb-app\\.js|(^|/)bb-server( |$)"],
    { allowFailure: true, capture: true },
  );
  if (processes.status === 0) {
    throw new VpsUpdateError(
      `--bootstrap found a running BB process: ${processes.stdout}`,
      VPS_UPDATE_EXIT_CODES.unsupported,
    );
  }
  const listeners = run(
    "ss",
    ["-ltn", "sport", "=", `:${process.env.BB_SERVER_PORT ?? "38886"}`],
    {
      allowFailure: true,
      capture: true,
    },
  );
  if (listeners.status === 0 && listeners.stdout.split("\n").length > 1) {
    throw new VpsUpdateError(
      "--bootstrap found an existing BB server-port listener",
      VPS_UPDATE_EXIT_CODES.unsupported,
    );
  }
}

async function pruneOwnedReleases(releaseRoot, preservedTargets, keep = 3) {
  const preserved = new Set(
    preservedTargets
      .filter((target) => target && target !== "none")
      .map((target) => path.resolve(target)),
  );
  const candidates = [];
  for (const name of await readdir(releaseRoot)) {
    const releaseDir = path.join(releaseRoot, name);
    if (preserved.has(path.resolve(releaseDir))) continue;
    let marker;
    try {
      marker = JSON.parse(
        await readFile(path.join(releaseDir, ".bb-vps-release.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (marker.complete !== true || marker.commit !== name) continue;
    candidates.push({
      releaseDir,
      modifiedAt: (await stat(releaseDir)).mtimeMs,
    });
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const candidate of candidates.slice(keep)) {
    run("chmod", ["-R", "u+w", candidate.releaseDir]);
    run("git", ["worktree", "remove", "--force", candidate.releaseDir]);
  }
}

async function reserveCandidateBuild({
  releaseRoot,
  commit,
  updatesDir,
  operationId,
}) {
  const releaseDir = path.join(releaseRoot, commit);
  try {
    const marker = JSON.parse(
      await readFile(path.join(releaseDir, ".bb-vps-release.json"), "utf8"),
    );
    if (marker.complete === true && marker.commit === commit) {
      return { releaseDir, ownerPath: null };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    const existing = await lstat(releaseDir);
    if (existing)
      throw new Error(
        `incomplete or foreign release directory exists at ${releaseDir}`,
      );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const ownerPath = path.join(updatesDir, `${operationId}.candidate`);
  await writeFile(
    ownerPath,
    `${JSON.stringify({ operationId, commit, releaseDir })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return { releaseDir, ownerPath };
}

export async function recoverCandidateBuild(
  { releaseRoot, operationId, ownerPath },
  runtime = {},
) {
  let owner;
  try {
    const ownerIdentity = await lstat(ownerPath);
    if (
      !ownerIdentity.isFile() ||
      ownerIdentity.isSymbolicLink() ||
      (ownerIdentity.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" &&
        ownerIdentity.uid !== process.getuid())
    ) {
      throw new Error(
        "candidate build owner must be a service-user file with mode 0600",
      );
    }
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const expectedRelease = path.join(releaseRoot, owner.commit ?? "");
  if (
    owner.operationId !== operationId ||
    typeof owner.commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(owner.commit) ||
    owner.releaseDir !== expectedRelease ||
    path.dirname(expectedRelease) !== path.resolve(releaseRoot)
  ) {
    throw new Error("candidate build owner file is invalid");
  }
  let entry;
  try {
    entry = await lstat(expectedRelease);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (entry) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("owned candidate release is not a directory");
    }
    let complete = false;
    try {
      const marker = JSON.parse(
        await readFile(
          path.join(expectedRelease, ".bb-vps-release.json"),
          "utf8",
        ),
      );
      complete = marker.complete === true && marker.commit === owner.commit;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!complete) {
      if (runtime.removeCandidate) {
        await runtime.removeCandidate(expectedRelease);
      } else {
        run("chmod", ["-R", "u+w", expectedRelease], { allowFailure: true });
        const removed = run(
          "git",
          ["worktree", "remove", "--force", expectedRelease],
          { allowFailure: true },
        );
        if (removed.status !== 0) {
          await rm(expectedRelease, { recursive: true, force: true });
        }
      }
    }
  }
  await rm(ownerPath, { force: true });
  return true;
}

async function createCandidate({
  releaseRoot,
  commit,
  operationId,
  dataDir,
  stateRoot,
}) {
  const releaseDir = path.join(releaseRoot, commit);
  let reusable = false;
  try {
    const marker = JSON.parse(
      await readFile(path.join(releaseDir, ".bb-vps-release.json"), "utf8"),
    );
    reusable = marker.complete === true && marker.commit === commit;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (reusable) return releaseDir;
  try {
    const existing = await lstat(releaseDir);
    if (existing)
      throw new Error(
        `incomplete or foreign release directory exists at ${releaseDir}`,
      );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  run("git", ["worktree", "add", "--detach", releaseDir, commit]);
  const cacheDir = path.join(stateRoot, "build-cache", operationId);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const pnpmPath = run("/usr/bin/env", ["sh", "-c", "command -v pnpm"], {
    capture: true,
  }).stdout;
  const toolPaths = [
    path.dirname(path.dirname(await realpath(process.execPath))),
    path.dirname(pnpmPath),
    path.dirname(await realpath(pnpmPath)),
  ].filter((toolPath, index, paths) => paths.indexOf(toolPath) === index);
  await validateCandidateFetchInputs(releaseDir);
  const commands = candidateBuildCommands(dataDir, cacheDir);
  for (const command of commands) {
    const sandbox = buildSandboxCommand({
      operationId,
      candidateDir: releaseDir,
      cacheDir,
      dataDir,
      toolPaths,
      network: candidateCommandNeedsNetwork(command),
      command,
    });
    run(sandbox.executable, sandbox.args, { timeoutMs: 900_000 });
  }
  assertCandidateNativeArchitecture(releaseDir);
  await writeFile(
    path.join(releaseDir, ".bb-vps-release.json"),
    `${JSON.stringify({ commit, complete: true })}\n`,
    { mode: 0o444 },
  );
  await makeReleaseReadOnly(releaseDir);
  return releaseDir;
}

async function readLatestOperationId(updatesDir) {
  const latestPath = path.join(updatesDir, "latest");
  return (await readFile(latestPath, "utf8")).trim();
}

async function showStatus(updatesDir, operationId) {
  const resolvedId =
    operationId === "latest"
      ? await readLatestOperationId(updatesDir)
      : operationId;
  console.log(
    JSON.stringify(await readVpsOperation(updatesDir, resolvedId), null, 2),
  );
}

export async function recoverVpsRelease(
  { operationId, ownerSecret, record },
  { admin, runtime },
) {
  const postActivationPhases = new Set([
    "sealed",
    "activating",
    "verifying",
    "plugins",
    "rolling-back",
    "rollback-failed",
    "releasing",
    "candidate-failed",
    "plugin-failed",
    "release-failed",
  ]);
  if (postActivationPhases.has(record.phase)) {
    if (record.previousRelease && record.previousRelease !== "none") {
      await runtime.restorePrevious(record.previousRelease);
    } else if (!ownerSecret) {
      await runtime.restoreInactive();
    } else {
      throw new VpsUpdateError(
        "retained maintenance has no previous release to restore",
        VPS_UPDATE_EXIT_CODES.releaseFailed,
      );
    }
  }
  if (!ownerSecret) return;
  const status = await admin.status();
  const lease = status.lease;
  if (lease && lease.operationId !== operationId) {
    throw new VpsUpdateError(
      `maintenance is owned by ${lease.operationId}, not ${operationId}`,
      VPS_UPDATE_EXIT_CODES.contention,
    );
  }
  if (lease?.phase === "draining" || lease?.phase === "sealing") {
    await admin.recover(operationId);
    return;
  }
  if (!lease) return;
  if (lease.phase !== "rolling-back" && lease.phase !== "releasing") {
    await admin.transition({
      operationId,
      ownerSecret,
      expectedPhase: lease.phase,
      phase: "rolling-back",
    });
  }
  await admin.release({
    operationId,
    ownerSecret,
    resolution: "rolled-back",
  });
}

async function recoverOperation({
  updatesDir,
  operationId,
  currentPath,
  dataDir,
  releaseRoot,
}) {
  const record = await readVpsOperation(updatesDir, operationId);
  assertOperationDataDir(record, dataDir);
  await recoverCandidateBuild({
    releaseRoot,
    operationId,
    ownerPath: path.join(updatesDir, `${operationId}.candidate`),
  });
  const ownerPath = path.join(updatesDir, `${operationId}.owner`);
  let ownerSecret = null;
  try {
    ownerSecret = (await readFile(ownerPath, "utf8")).trim();
    if (!ownerSecret) {
      throw new VpsUpdateError(
        "operation owner file is empty",
        VPS_UPDATE_EXIT_CODES.releaseFailed,
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let admin;
  if (ownerSecret) {
    admin = createMaintenanceAdminClient(dataDir, ownerSecret);
  }
  await recoverVpsRelease(
    { operationId, ownerSecret, record },
    {
      admin,
      runtime: {
        restorePrevious: async (previousRelease) => {
          const validatedRelease = await validateOwnedVpsRelease(
            releaseRoot,
            previousRelease,
          );
          await atomicCurrentSwitch(currentPath, validatedRelease);
          run("systemctl", ["--user", "restart", "bb-local.service"], {
            timeoutMs: 30_000,
          });
          assertCurrentReleaseTarget(
            await readlink(currentPath),
            validatedRelease,
          );
          await verifyServiceProcessRelease(validatedRelease);
          await waitForHealth(healthUrl());
          if (admin) {
            await waitForRuntimeIdentity(admin, validatedRelease, [], true);
          }
        },
        restoreInactive: async () => {
          run("systemctl", ["--user", "stop", "bb-local.service"], {
            timeoutMs: 30_000,
          });
          await rm(currentPath, { force: true });
        },
      },
    },
  );
  if (ownerSecret) {
    await rm(ownerPath, { force: true });
  }
  console.log(`Recovered maintenance operation ${operationId}`);
}

export async function updateLocalVps(argv) {
  const options = parseVpsUpdateArgs(argv);
  assertSupportedHost(process.platform, process.arch);
  if (
    run("/usr/bin/test", ["-x", "/usr/bin/flock"], { allowFailure: true })
      .status !== 0
  ) {
    throw new VpsUpdateError(
      "/usr/bin/flock is required",
      VPS_UPDATE_EXIT_CODES.unsupported,
    );
  }
  const homeDir = os.homedir();
  const dataDir = await resolveVpsDataDir(options, homeDir);
  if (!path.isAbsolute(dataDir))
    throw new VpsUpdateError(
      "BB data directory must be absolute",
      VPS_UPDATE_EXIT_CODES.usage,
    );
  const stateRoot = path.join(homeDir, ".local", "state", "bb-local");
  const updatesDir = path.join(stateRoot, "updates");
  const releaseRoot = path.join(
    homeDir,
    ".local",
    "share",
    "bb-local",
    "releases",
  );
  const currentPath = path.join(
    homeDir,
    ".local",
    "share",
    "bb-local",
    "current",
  );
  await mkdir(updatesDir, { recursive: true, mode: 0o700 });
  if (options.status) return showStatus(updatesDir, options.status);
  if (options.recover) {
    try {
      return await recoverOperation({
        updatesDir,
        operationId: options.recover,
        currentPath,
        dataDir,
        releaseRoot,
      });
    } catch (error) {
      throw asVpsRecoveryError(error);
    }
  }
  const operationId = process.env.BB_VPS_OPERATION_ID ?? randomUUID();
  const store = await createVpsOperationStore({ updatesDir, operationId });
  await writeFile(path.join(updatesDir, "latest"), `${operationId}\n`, {
    mode: 0o600,
  });
  await store.transition("validating", { dataDir });
  let branch;
  let commit;
  let previousForkHead;
  let remotes;
  let upstreamRef;
  let externalPlugins = [];
  try {
    branch = requireCleanPrimary();
    assertPushBranch(branch, forkBranch, options.push);
    remotes = activeRemotes();
    await validateToolchain(releaseRoot);
    run("systemctl", ["--user", "show-environment"], {
      capture: true,
      timeoutMs: 10_000,
    });
    run("git", ["fetch", remotes.upstream, upstreamBranch]);
    run("git", ["fetch", remotes.fork, forkBranch]);
    upstreamRef = `${remotes.upstream}/${upstreamBranch}`;
    const behind = Number(
      gitOutput(["rev-list", "--count", `HEAD..${upstreamRef}`]),
    );
    const patchesBefore = Number(
      gitOutput(["rev-list", "--count", `${upstreamRef}..HEAD`]),
    );
    console.log(
      `Branch ${branch}: ${behind} upstream commit(s), ${patchesBefore} local patch commit(s)`,
    );
    console.log(`BB data directory: ${dataDir}`);
    console.log(
      `Maintenance socket: ${path.join(dataDir, "admin", "maintenance.sock")}`,
    );
    if (options.check) {
      await store.transition("complete", {
        checkedOnly: true,
        branch,
        upstreamRef,
      });
      return;
    }
    const previousForkHeadResult = run(
      "git",
      ["rev-parse", "--verify", `refs/remotes/${remotes.fork}/${forkBranch}`],
      { allowFailure: true, capture: true },
    );
    previousForkHead =
      previousForkHeadResult.status === 0
        ? previousForkHeadResult.stdout
        : null;
    if (
      run("git", ["merge-base", "--is-ancestor", upstreamRef, "HEAD"], {
        allowFailure: true,
      }).status !== 0
    ) {
      run("git", ["rebase", upstreamRef]);
    }
    requireCleanPrimary();
    commit = gitOutput(["rev-parse", "HEAD"]);
    await validateToolchain(releaseRoot);
    if (options.plugins && !options.stageOnly && !options.bootstrap) {
      externalPlugins = await resolveExternalPlugins(externalPluginCollections);
      console.log(
        `External plugin(s) to synchronize: ${externalPlugins
          .map((plugin) => plugin.id)
          .join(", ")}`,
      );
    }
    await store.transition("validating", {
      branch,
      upstreamRef,
      previousForkHead,
      commit,
      dataDir,
    });
  } catch (error) {
    await store.transition("validation-failed", {
      dataDir,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new VpsUpdateError(
      "VPS update validation failed",
      VPS_UPDATE_EXIT_CODES.usage,
      error,
    );
  }
  let candidateReservation;
  try {
    candidateReservation = await reserveCandidateBuild({
      releaseRoot,
      commit,
      updatesDir,
      operationId,
    });
  } catch (error) {
    await store.transition("build-failed", {
      candidateRelease: path.join(releaseRoot, commit),
      error: error instanceof Error ? error.message : String(error),
    });
    throw new VpsUpdateError(
      "VPS candidate reservation failed",
      VPS_UPDATE_EXIT_CODES.usage,
      error,
    );
  }
  await store.transition("building", {
    candidateRelease: candidateReservation.releaseDir,
  });
  let candidateDir;
  try {
    await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
    candidateDir = await createCandidate({
      releaseRoot,
      commit,
      operationId,
      dataDir,
      stateRoot,
    });
    if (candidateReservation.ownerPath) {
      await rm(candidateReservation.ownerPath, { force: true });
    }
  } catch (error) {
    await store.transition("build-failed", {
      candidateRelease: commit,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new VpsUpdateError(
      "VPS candidate build failed",
      VPS_UPDATE_EXIT_CODES.usage,
      error,
    );
  }
  if (options.stageOnly) {
    await store.transition("complete", {
      candidateRelease: candidateDir,
      stagedOnly: true,
    });
    return;
  }
  let previousRelease;
  try {
    previousRelease = await validateOwnedVpsRelease(
      releaseRoot,
      await readlink(currentPath),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    previousRelease = "none";
  }
  if (!options.bootstrap && previousRelease === "none") {
    throw new VpsUpdateError(
      "no active release exists; install bb-local.service and rerun with --bootstrap",
      VPS_UPDATE_EXIT_CODES.unsupported,
    );
  }
  let ownerPath;
  if (options.bootstrap) {
    await assertBootstrapInactive();
    const bootstrapAdmin = createMaintenanceAdminClient(dataDir, null);
    await activateBootstrapRelease(
      { candidateRelease: candidateDir, previousRelease },
      {
        runtime: {
          reportPhase: (phase) =>
            store.transition(phase, {
              candidateRelease: candidateDir,
              previousRelease,
            }),
          switchCurrent: (target) => atomicCurrentSwitch(currentPath, target),
          start: async () =>
            run("systemctl", ["--user", "start", "bb-local.service"], {
              timeoutMs: 30_000,
            }),
          verify: async (expectedRelease) => {
            if ((await readlink(currentPath)) !== expectedRelease) {
              throw new Error(
                "current release target changed during verification",
              );
            }
            await verifyServiceProcessRelease(expectedRelease);
            await waitForHealth(healthUrl());
            await waitForRuntimeIdentity(
              bootstrapAdmin,
              expectedRelease,
              [],
              true,
            );
          },
          restorePrevious: async (target) => {
            await atomicCurrentSwitch(currentPath, target);
            run("systemctl", ["--user", "restart", "bb-local.service"], {
              timeoutMs: 30_000,
            });
            assertCurrentReleaseTarget(await readlink(currentPath), target);
            await verifyServiceProcessRelease(target);
            await waitForHealth(healthUrl());
          },
          restoreInactive: async () => {
            run("systemctl", ["--user", "stop", "bb-local.service"], {
              allowFailure: true,
              timeoutMs: 30_000,
            });
            await rm(currentPath, { force: true });
          },
          reportFailure: (error) =>
            store.transition("candidate-failed", {
              candidateRelease: candidateDir,
              previousRelease,
              error: error instanceof Error ? error.message : String(error),
            }),
        },
      },
    );
  } else {
    const ownerSecret = randomBytes(32).toString("base64url");
    ownerPath = path.join(updatesDir, `${operationId}.owner`);
    await writeFile(ownerPath, `${ownerSecret}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const admin = createMaintenanceAdminClient(dataDir, ownerSecret);
    try {
      await waitForRuntimeIdentity(admin, previousRelease, [], true);
    } catch (error) {
      throw new VpsUpdateError(
        "the running release has no compatible maintenance socket; stop bb-local.service and rerun with --bootstrap",
        VPS_UPDATE_EXIT_CODES.unsupported,
        error,
      );
    }
    await store.transition("draining", {
      candidateRelease: candidateDir,
      previousRelease,
    });
    try {
      await activateVpsRelease(
        {
          operationId,
          ownerSecret,
          reason: `activate ${commit}`,
          ttlMs: defaultTtlMs,
          candidateRelease: candidateDir,
          previousRelease,
          allowActiveWork: options.allowActiveWork,
          plugins: options.plugins,
        },
        {
          admin,
          runtime: {
            switchCurrent: (target) => atomicCurrentSwitch(currentPath, target),
            restart: async () =>
              run("systemctl", ["--user", "restart", "bb-local.service"], {
                timeoutMs: 30_000,
              }),
            waitForAdmin: (expectedRelease) =>
              waitForRuntimeIdentity(admin, expectedRelease),
            verify: async (identity, expectedHostIds) => {
              if ((await readlink(currentPath)) !== identity)
                throw new Error(
                  "current release target changed during verification",
                );
              await verifyServiceProcessRelease(identity);
              await waitForHealth(healthUrl());
              await waitForRuntimeIdentity(admin, identity, expectedHostIds);
              await admin.status();
            },
            confirmActiveWork,
            reportPhase: (phase) =>
              store.transition(phase, {
                candidateRelease: candidateDir,
                previousRelease,
              }),
            installPlugins: async () => {
              const cli =
                process.env.BB_CLI ??
                path.join(
                  candidateDir,
                  "packages",
                  "bb-app",
                  "host-daemon",
                  "dist",
                  "bb",
                );
              syncVpsPlugins({
                cli,
                plugins: externalPlugins,
                collections: externalPluginCollections,
              });
            },
          },
        },
      );
    } catch (error) {
      const phase =
        error instanceof VpsUpdateError && error.operationPhase
          ? error.operationPhase
          : error instanceof VpsUpdateError &&
              error.exitCode === VPS_UPDATE_EXIT_CODES.rollbackFailed
            ? "rollback-failed"
            : error instanceof VpsUpdateError &&
                error.exitCode === VPS_UPDATE_EXIT_CODES.releaseFailed
              ? "release-failed"
              : error instanceof VpsUpdateError &&
                  error.exitCode === VPS_UPDATE_EXIT_CODES.activeWork
                ? "active-work-refused"
                : "candidate-failed";
      await store.transition(phase, {
        candidateRelease: candidateDir,
        previousRelease,
        error: error instanceof Error ? error.message : String(error),
      });
      if (
        error instanceof VpsUpdateError &&
        (error.exitCode === VPS_UPDATE_EXIT_CODES.activeWork ||
          error.exitCode === VPS_UPDATE_EXIT_CODES.candidateRolledBack)
      ) {
        await rm(ownerPath, { force: true });
      }
      throw error;
    }
  }
  if (ownerPath) await rm(ownerPath, { force: true });
  await store.transition("pruning", {
    candidateRelease: candidateDir,
    previousRelease,
  });
  try {
    await pruneOwnedReleases(releaseRoot, [candidateDir, previousRelease]);
  } catch (error) {
    await store.transition("prune-failed", {
      candidateRelease: candidateDir,
      previousRelease,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new VpsUpdateError(
      "local release pruning failed before fork push",
      VPS_UPDATE_EXIT_CODES.releaseFailed,
      error,
    );
  }
  if (options.push) {
    await store.transition("pushing", {
      candidateRelease: candidateDir,
      previousRelease,
    });
    try {
      run("git", pushArguments(previousForkHead, remotes.fork, forkBranch));
    } catch (error) {
      await store.transition("push-failed", {
        candidateRelease: candidateDir,
        previousRelease,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new VpsUpdateError(
        `local activation succeeded but fork push failed; retry: git ${pushArguments(previousForkHead, remotes.fork, forkBranch).join(" ")}`,
        VPS_UPDATE_EXIT_CODES.pushFailed,
        error,
      );
    }
  }
  await store.transition("complete", {
    candidateRelease: candidateDir,
    previousRelease,
  });
  console.log(`bb local VPS activated release ${commit}`);
}

async function runUnderFlock(argv) {
  assertSupportedHost(process.platform, process.arch);
  const options = parseVpsUpdateArgs(argv);
  if (options.status !== undefined) return updateLocalVps(argv);
  if (
    run("/usr/bin/test", ["-x", "/usr/bin/flock"], { allowFailure: true })
      .status !== 0
  ) {
    throw new VpsUpdateError(
      "/usr/bin/flock is required",
      VPS_UPDATE_EXIT_CODES.unsupported,
    );
  }
  if (process.env.BB_VPS_UPDATE_LOCKED === "1") return updateLocalVps(argv);
  const stateRoot = path.join(os.homedir(), ".local", "state", "bb-local");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const operationId = randomUUID();
  const result = spawnSync(
    "/usr/bin/flock",
    [
      "-n",
      "-E",
      String(VPS_UPDATE_EXIT_CODES.contention),
      path.join(stateRoot, "update.lock"),
      process.execPath,
      fileURLToPath(import.meta.url),
      ...argv,
    ],
    {
      env: {
        ...process.env,
        BB_VPS_UPDATE_LOCKED: "1",
        BB_VPS_OPERATION_ID: operationId,
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status === VPS_UPDATE_EXIT_CODES.contention) {
    let runningOperation = "unknown";
    try {
      runningOperation = await readLatestOperationId(
        path.join(stateRoot, "updates"),
      );
    } catch {}
    throw new VpsUpdateError(
      `another VPS update holds the lock (operation ${runningOperation}); run pnpm vps:local:update -- --status ${runningOperation}`,
      VPS_UPDATE_EXIT_CODES.contention,
    );
  }
  process.exitCode = result.status ?? 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runUnderFlock(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode =
      error instanceof VpsUpdateError
        ? error.exitCode
        : VPS_UPDATE_EXIT_CODES.usage;
  });
}
