import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import {
  VPS_NODE_ENGINE,
  VpsUpdateError,
  activateBootstrapRelease,
  activateVpsRelease,
  asVpsRecoveryError,
  assertCurrentReleaseTarget,
  assertCandidateNativeArchitecture,
  assertOperationDataDir,
  assertRuntimeReleaseIdentity,
  assertServiceProcessRelease,
  assertSupportedHost,
  assertSupportedVpsNode,
  assertPushBranch,
  buildSandboxCommand,
  candidateBuildCommands,
  candidateCommandNeedsNetwork,
  createMaintenanceAdminClient,
  matchesPackageManagerVersion,
  parseVpsUpdateArgs,
  parseStoredDataDir,
  recoverCandidateBuild,
  recoverVpsRelease,
  resolveVpsDataDir,
  satisfiesNodeEngine,
  syncVpsPlugins,
  validateCandidateFetchInputs,
  validateOwnedVpsRelease,
  waitForServiceProcessRelease,
} from "./update-local-vps.mjs";

test("supports only Linux arm64", () => {
  assert.doesNotThrow(() => assertSupportedHost("linux", "arm64"));
  assert.throws(() => assertSupportedHost("linux", "x64"), /Linux arm64 only/u);
  assert.throws(
    () => assertSupportedHost("darwin", "arm64"),
    /Linux arm64 only/u,
  );
});

test("validates the packaged runtime native addon architecture", () => {
  const releaseDir = path.join(path.sep, "srv", "bb", "release");
  let inspectedPath = null;
  assert.doesNotThrow(() =>
    assertCandidateNativeArchitecture(releaseDir, (command, args, options) => {
      assert.equal(command, "file");
      assert.deepEqual(options, { capture: true });
      inspectedPath = args[0];
      return { stdout: "ELF 64-bit LSB shared object, ARM aarch64" };
    }),
  );
  assert.equal(
    inspectedPath,
    path.join(
      releaseDir,
      "packages",
      "bb-app",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    ),
  );
  assert.throws(
    () =>
      assertCandidateNativeArchitecture(releaseDir, () => ({
        stdout: "ELF 64-bit LSB shared object, x86-64",
      })),
    /candidate native dependency is not ARM64/u,
  );
});

test("pushes only the configured fork branch", () => {
  assert.doesNotThrow(() => assertPushBranch("main", "main", true));
  assert.doesNotThrow(() => assertPushBranch("feature", "main", false));
  assert.throws(
    () => assertPushBranch("feature", "main", true),
    /refusing to push branch feature over main/u,
  );
});

test("reads quoted service data directories including spaces", () => {
  assert.equal(parseStoredDataDir('"/srv/bb data"'), "/srv/bb data");
  assert.equal(parseStoredDataDir("/srv/legacy"), "/srv/legacy");
});

test("keeps updater and installed service data directories aligned", async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "bb-vps-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const configDir = path.join(homeDir, ".config", "bb-local");
  const serviceDataDir = path.join(homeDir, "bb data");
  const serviceDataDirLink = path.join(homeDir, "service data");
  const otherDataDir = path.join(homeDir, "other data");
  await mkdir(configDir, { recursive: true });
  await mkdir(serviceDataDir, { recursive: true });
  await mkdir(otherDataDir, { recursive: true });
  await symlink(serviceDataDir, serviceDataDirLink);
  const canonicalServiceDataDir = await realpath(serviceDataDir);
  await writeFile(
    path.join(configDir, "environment"),
    `BB_DATA_DIR=${JSON.stringify(serviceDataDirLink)}\n`,
  );

  assert.equal(
    await resolveVpsDataDir({}, homeDir, {}),
    canonicalServiceDataDir,
  );
  assert.equal(
    await resolveVpsDataDir({ dataDir: serviceDataDirLink }, homeDir, {}),
    canonicalServiceDataDir,
  );
  await assert.rejects(
    resolveVpsDataDir({ dataDir: otherDataDir }, homeDir, {}),
    /does not match the installed service directory/u,
  );
  await rm(serviceDataDirLink);
  await symlink(otherDataDir, serviceDataDirLink);
  await assert.rejects(
    resolveVpsDataDir({ dataDir: serviceDataDir }, homeDir, {}),
    /does not match the installed service directory/u,
  );
});

test("enforces both supported Node majors and the minimum patch", () => {
  const engine = "^22.19.0 || ^24.0.0 || ^26.0.0";
  assert.equal(satisfiesNodeEngine("22.19.0", engine), true);
  assert.equal(satisfiesNodeEngine("24.3.1", engine), true);
  assert.equal(satisfiesNodeEngine("26.0.0", engine), true);
  assert.equal(satisfiesNodeEngine("22.18.9", engine), false);
  assert.equal(satisfiesNodeEngine("23.0.0", engine), false);
  assert.equal(satisfiesNodeEngine("25.0.0", engine), false);
  assert.equal(satisfiesNodeEngine("27.0.0", engine), false);
  assert.equal(satisfiesNodeEngine("24.0", engine), false);
});

test("pins Linux arm64 VPS releases to the Node 22 line", () => {
  assert.equal(VPS_NODE_ENGINE, "^22.19.0");
  assert.doesNotThrow(() => assertSupportedVpsNode("22.19.0"));
  assert.doesNotThrow(() => assertSupportedVpsNode("22.23.2"));
  assert.throws(
    () => assertSupportedVpsNode("22.18.9"),
    /must satisfy \^22\.19\.0/u,
  );
  assert.throws(
    () => assertSupportedVpsNode("24.21.0"),
    /must satisfy \^22\.19\.0/u,
  );
  assert.throws(
    () => assertSupportedVpsNode("26.0.0"),
    /must satisfy \^22\.19\.0/u,
  );
});

test("requires the exact repository pnpm version", () => {
  assert.equal(matchesPackageManagerVersion("9.15.0", "pnpm@9.15.0"), true);
  assert.equal(matchesPackageManagerVersion("9.14.4", "pnpm@9.15.0"), false);
  assert.equal(matchesPackageManagerVersion("9.16.0", "pnpm@9.15.0"), false);
  assert.equal(
    matchesPackageManagerVersion("9.15.0-dev", "pnpm@9.15.0"),
    false,
  );
});

test("requires the authenticated runtime to identify the selected release", () => {
  assert.doesNotThrow(() =>
    assertRuntimeReleaseIdentity(
      {
        service: "bb-maintenance",
        protocolVersion: 2,
        releaseIdentity: "/srv/releases/abc",
        connectedHostIds: ["host-1"],
      },
      "/srv/releases/abc",
      ["host-1"],
    ),
  );
  assert.throws(
    () =>
      assertRuntimeReleaseIdentity(
        {
          service: "bb-maintenance",
          protocolVersion: 2,
          releaseIdentity: "/srv/releases/stale",
          connectedHostIds: ["host-1"],
        },
        "/srv/releases/abc",
      ),
    /does not match/u,
  );
  assert.throws(
    () =>
      assertRuntimeReleaseIdentity(
        {
          service: "bb-maintenance",
          protocolVersion: 2,
          releaseIdentity: "/srv/releases/abc",
          connectedHostIds: [],
        },
        "/srv/releases/abc",
        ["host-1"],
      ),
    /missing expected host daemons/u,
  );
  assert.throws(
    () =>
      assertRuntimeReleaseIdentity(
        {
          service: "bb-maintenance",
          protocolVersion: 2,
          releaseIdentity: "/srv/releases/abc",
          connectedHostIds: [],
        },
        "/srv/releases/abc",
        [],
        true,
      ),
    /no connected host daemon/u,
  );
  assert.throws(
    () =>
      assertRuntimeReleaseIdentity(
        {
          service: "bb-maintenance",
          protocolVersion: 1,
          releaseIdentity: "/srv/releases/abc",
          connectedHostIds: ["host-1"],
        },
        "/srv/releases/abc",
      ),
    /does not implement maintenance protocol 2/u,
  );
});

test("requires the systemd main process to run from the selected release", () => {
  assert.doesNotThrow(() =>
    assertServiceProcessRelease("/srv/releases/abc", "/srv/releases/abc"),
  );
  assert.throws(
    () =>
      assertServiceProcessRelease("/srv/releases/stale", "/srv/releases/abc"),
    /does not match/u,
  );
});

test("waits for systemd's executor to enter the selected release", async () => {
  const expectedRelease = "/srv/releases/abc";
  const processDirectories = ["/", expectedRelease];
  let clock = 0;
  let processIndex = 0;
  await waitForServiceProcessRelease(expectedRelease, {
    execute(command, args, options) {
      assert.equal(command, "systemctl");
      assert.deepEqual(args, [
        "--user",
        "show",
        "bb-local.service",
        "--property",
        "MainPID",
        "--value",
      ]);
      assert.deepEqual(options, { capture: true, timeoutMs: 10_000 });
      return { stdout: processIndex === 0 ? "101" : "102" };
    },
    async resolveRealpath(processPath) {
      assert.equal(processPath, `/proc/${processIndex === 0 ? 101 : 102}/cwd`);
      return processDirectories[processIndex];
    },
    async wait(delayMs) {
      assert.equal(delayMs, 50);
      processIndex += 1;
      clock += delayMs;
    },
    now: () => clock,
    deadlineMs: 100,
  });
  assert.equal(processIndex, 1);
});

test("requires current to retain the selected release target", () => {
  assert.doesNotThrow(() =>
    assertCurrentReleaseTarget("/srv/releases/abc", "/srv/releases/abc"),
  );
  assert.throws(
    () =>
      assertCurrentReleaseTarget("/srv/releases/stale", "/srv/releases/abc"),
    /does not match/u,
  );
});

test("uses the updater's Unix-socket client for maintenance secrets", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-vps-admin-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const adminDir = path.join(dataDir, "admin");
  const socketPath = path.join(adminDir, "maintenance.sock");
  await mkdir(adminDir, { recursive: true });
  await writeFile(path.join(adminDir, "capability"), "capability-secret\n", {
    mode: 0o600,
  });
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
          : null,
        url: request.url,
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/identity"
            ? {
                service: "bb-maintenance",
                protocolVersion: 2,
                releaseIdentity: "/srv/releases/abc",
                connectedHostIds: ["host-1"],
              }
            : { lease: null, barrier: [], activity: { activeByKind: {} } },
        ),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const client = createMaintenanceAdminClient(dataDir, "owner-secret");
  try {
    assert.equal((await client.identity()).protocolVersion, 2);
    await client.release({ operationId: "op-1", resolution: "rolled-back" });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  assert.deepEqual(requests, [
    {
      authorization: "Bearer capability-secret",
      body: null,
      url: "/identity",
    },
    {
      authorization: "Bearer capability-secret",
      body: {
        operationId: "op-1",
        resolution: "rolled-back",
        ownerSecret: "owner-secret",
      },
      url: "/maintenance/release",
    },
  ]);
});

test("maps every recovery failure to the documented exit code", () => {
  const ordinary = new Error("socket unavailable");
  const wrapped = asVpsRecoveryError(ordinary);
  assert.equal(wrapped.exitCode, 9);
  assert.equal(wrapped.cause, ordinary);

  const retained = new VpsUpdateError("retained", 9);
  assert.equal(asVpsRecoveryError(retained), retained);
  assert.equal(
    asVpsRecoveryError(new VpsUpdateError("contention", 4)).exitCode,
    9,
  );
});

test("binds recovery to the operation's immutable data directory", () => {
  assert.doesNotThrow(() =>
    assertOperationDataDir({ dataDir: "/srv/bb" }, "/srv/bb"),
  );
  assert.throws(
    () => assertOperationDataDir({ dataDir: "/srv/old" }, "/srv/new"),
    /does not match the selected service directory/u,
  );
  assert.throws(
    () => assertOperationDataDir({}, "/srv/new"),
    /operation data directory undefined/u,
  );
});

test("parses headless update modes without ambiguous restart behavior", () => {
  assert.deepEqual(parseVpsUpdateArgs([]), {
    allowActiveWork: false,
    bootstrap: false,
    check: false,
    dataDir: undefined,
    plugins: true,
    push: true,
    recover: undefined,
    stageOnly: false,
    status: undefined,
  });
  assert.deepEqual(
    parseVpsUpdateArgs([
      "--",
      "--stage-only",
      "--skip-plugins",
      "--skip-push",
      "--allow-active-work",
      "--data-dir",
      "/srv/bb-data",
    ]),
    {
      allowActiveWork: true,
      bootstrap: false,
      check: false,
      dataDir: "/srv/bb-data",
      plugins: false,
      push: false,
      recover: undefined,
      stageOnly: true,
      status: undefined,
    },
  );
  assert.deepEqual(parseVpsUpdateArgs(["--status", "op-1"]), {
    allowActiveWork: false,
    bootstrap: false,
    check: false,
    dataDir: undefined,
    plugins: true,
    push: true,
    recover: undefined,
    stageOnly: false,
    status: "op-1",
  });
  assert.throws(
    () => parseVpsUpdateArgs(["--skip-restart"]),
    /unknown argument/u,
  );
  assert.throws(
    () => parseVpsUpdateArgs(["--data-dir", "relative"]),
    /absolute path/u,
  );
});

test("build sandbox hides production state and constrains candidate writes", () => {
  const command = buildSandboxCommand({
    operationId: "op-1",
    candidateDir: "/srv/releases/abc",
    cacheDir: "/srv/state/build-cache",
    dataDir: "/srv/data",
    toolPaths: ["/opt/node"],
    userRuntimeDir: "/run/user/1000",
    command: ["pnpm", "install", "--frozen-lockfile"],
  });
  assert.equal(command.executable, "systemd-run");
  assert.ok(command.args.includes("ProtectSystem=strict"));
  assert.ok(command.args.includes("ProtectHome=read-only"));
  assert.ok(command.args.includes("PrivateTmp=yes"));
  assert.ok(command.args.includes("PrivateUsers=yes"));
  assert.ok(command.args.includes("PrivateDevices=yes"));
  assert.ok(command.args.includes("PrivateNetwork=yes"));
  assert.ok(command.args.includes("ProtectProc=ptraceable"));
  assert.ok(command.args.includes("ProcSubset=pid"));
  assert.ok(command.args.includes("RestrictNamespaces=yes"));
  assert.ok(
    command.args.includes("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"),
  );
  assert.ok(command.args.includes("NoNewPrivileges=yes"));
  assert.ok(command.args.includes("RestrictSUIDSGID=yes"));
  assert.ok(command.args.includes("UMask=0077"));
  assert.ok(
    command.args.includes(
      'ReadWritePaths="/srv/releases/abc" "/srv/state/build-cache"',
    ),
  );
  assert.ok(
    command.args.includes(
      'BindPaths="/srv/releases/abc" "/srv/state/build-cache"',
    ),
  );
  assert.ok(command.args.includes('BindReadOnlyPaths="/opt/node"'));
  assert.ok(
    command.args.includes(
      'InaccessiblePaths="/srv/data" "/run/user/1000" "-/run/containerd" "-/run/dbus" "-/run/docker.sock" "-/run/podman" "-/var/run/docker.sock" "-/var/run/podman"',
    ),
  );
  assert.ok(
    command.args.includes(
      "PATH=/opt/node:/opt/node/bin:/usr/local/bin:/usr/bin:/bin",
    ),
  );
  assert.ok(
    command.args.includes("TURBO_CACHE_DIR=/srv/state/build-cache/turbo-cache"),
  );
  assert.ok(command.args.includes("npm_config_nodedir=/opt/node"));
  assert.deepEqual(command.args.slice(-3), [
    "pnpm",
    "install",
    "--frozen-lockfile",
  ]);

  const fetchCommand = buildSandboxCommand({
    operationId: "op-2",
    candidateDir: "/srv/releases/def",
    cacheDir: "/srv/state/build-cache",
    dataDir: "/srv/data",
    toolPaths: ["/opt/node"],
    userRuntimeDir: "/run/user/1000",
    network: true,
    command: ["pnpm", "fetch", "--ignore-scripts", "--ignore-pnpmfile"],
  });
  assert.ok(fetchCommand.args.includes("PrivateNetwork=no"));
  assert.ok(
    fetchCommand.args.includes(
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    ),
  );
  assert.deepEqual(candidateBuildCommands("/srv/data").slice(0, 3), [
    ["/usr/bin/test", "!", "-r", "/srv/data/bb.db"],
    ["/usr/bin/test", "!", "-r", "/srv/data/admin/capability"],
    ["/usr/bin/test", "!", "-r", "/srv/data/admin/operations"],
  ]);

  const commands = candidateBuildCommands("/srv/data", "/srv/cache", [
    "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
  ]);
  const sharedRuntimeTestCommand = commands.find((candidate) =>
    candidate.includes("local/plugins/shared-runtime/test/manifest.test.mjs"),
  );
  assert.deepEqual(sharedRuntimeTestCommand, [
    "node",
    "--test",
    "--test-concurrency=1",
    "local/plugins/shared-runtime/test/manifest.test.mjs",
    "local/plugins/shared-runtime/test/runtime.test.mjs",
  ]);
  const cacheIndex = commands.findIndex(
    (candidate) => candidate[0] === "npm" && candidate[1] === "cache",
  );
  const ciIndex = commands.findIndex(
    (candidate) => candidate.includes("npm") && candidate.includes("ci"),
  );
  const smokeWarmIndex = commands.findIndex(
    (candidate) =>
      candidate[0] === "npm" &&
      candidate[1] === "install" &&
      candidate.includes("--install-links=true"),
  );
  const smokeIndex = commands.findIndex((candidate) =>
    candidate.includes("smoke:tarball"),
  );
  const firstExecutableIndex = commands.findIndex(
    (candidate) => candidate[0] === "pnpm" && candidate[1] === "install",
  );
  const nativeRebuildIndex = commands.findIndex(
    (candidate) =>
      candidate[0] === "pnpm" &&
      candidate.includes("rebuild") &&
      candidate.includes("better-sqlite3"),
  );
  assert.ok(cacheIndex > 2 && cacheIndex < firstExecutableIndex);
  assert.equal(nativeRebuildIndex, firstExecutableIndex + 1);
  assert.equal(
    candidateCommandNeedsNetwork(commands[nativeRebuildIndex]),
    false,
  );
  assert.ok(ciIndex > firstExecutableIndex);
  assert.ok(commands[ciIndex].includes("--offline"));
  assert.ok(commands[ciIndex].includes("--git=/usr/bin/false"));
  assert.ok(smokeWarmIndex > ciIndex && smokeWarmIndex < smokeIndex);
  assert.ok(commands[smokeWarmIndex].includes("--ignore-scripts"));
  assert.ok(commands[smokeWarmIndex].includes("--package-lock=false"));
  assert.ok(
    commands[smokeWarmIndex].includes("--registry=https://registry.npmjs.org"),
  );
  assert.ok(commands[smokeWarmIndex].includes("--git=/usr/bin/false"));
  assert.equal(candidateCommandNeedsNetwork(commands[smokeWarmIndex]), true);
  assert.ok(
    commands[smokeIndex].includes("BB_APP_SMOKE_USE_WORKSPACE_ARTIFACTS=true"),
  );
  assert.ok(commands[smokeIndex].includes("npm_config_offline=true"));
  assert.ok(commands[smokeIndex].includes("npm_config_fetch_retries=0"));
  assert.ok(commands[smokeIndex].includes("npm_config_userconfig=/dev/null"));
  assert.equal(candidateCommandNeedsNetwork(commands[smokeIndex]), false);
});

test(
  "build sandbox enters a bound home-directory candidate",
  {
    skip:
      process.platform !== "linux" ||
      process.env.BB_VPS_SYSTEMD_INTEGRATION !== "1",
  },
  async () => {
    const homeDir = homedir();
    const candidateParent = path.join(homeDir, ".local", "share");
    const cacheParent = path.join(homeDir, ".local", "state");
    await Promise.all([
      mkdir(candidateParent, { recursive: true }),
      mkdir(cacheParent, { recursive: true }),
    ]);
    let candidateDir;
    let cacheDir;
    let dataDir;
    try {
      candidateDir = await mkdtemp(
        path.join(candidateParent, ".bb-vps-build-candidate-"),
      );
      cacheDir = await mkdtemp(path.join(cacheParent, ".bb-vps-build-cache-"));
      dataDir = await mkdtemp(path.join(homeDir, ".bb-vps-build-data-"));
      const nodeRoot = path.dirname(
        path.dirname(await realpath(process.execPath)),
      );
      const command = buildSandboxCommand({
        operationId: `integration-${process.pid}`,
        candidateDir,
        cacheDir,
        dataDir,
        toolPaths: [nodeRoot],
        userRuntimeDir: `/run/user/${process.getuid()}`,
        command: ["/usr/bin/pwd"],
      });
      const result = spawnSync(command.executable, command.args, {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), candidateDir);
    } finally {
      await Promise.all(
        [candidateDir, cacheDir, dataDir]
          .filter((value) => value !== undefined)
          .map((value) => rm(value, { force: true, recursive: true })),
      );
    }
  },
);

test("candidate fetch inputs allow only integrity-pinned registry packages", async (t) => {
  const candidateDir = await mkdtemp(path.join(tmpdir(), "bb-vps-fetch-"));
  t.after(() => rm(candidateDir, { recursive: true, force: true }));
  const npmDir = path.join(candidateDir, "local", "plugins", "dir-skills");
  await mkdir(npmDir, { recursive: true });
  const safePnpmLock = [
    "lockfileVersion: '9.0'",
    "packages:",
    "  pkg@1.0.0:",
    "    resolution: {integrity: sha512-AAAA}",
    "",
  ].join("\n");
  const safeNpmLock = {
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/pkg": {
        resolved: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
        integrity: "sha512-AAAA",
      },
    },
  };
  await writeFile(path.join(candidateDir, "pnpm-lock.yaml"), safePnpmLock);
  await writeFile(
    path.join(npmDir, "package-lock.json"),
    JSON.stringify(safeNpmLock),
  );

  assert.deepEqual(await validateCandidateFetchInputs(candidateDir), [
    "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
  ]);

  await writeFile(
    path.join(candidateDir, ".npmrc"),
    "git=/tmp/candidate-git\n",
  );
  await assert.rejects(
    validateCandidateFetchInputs(candidateDir),
    /package-manager config is forbidden/u,
  );
  await rm(path.join(candidateDir, ".npmrc"));

  await writeFile(
    path.join(candidateDir, "pnpm-lock.yaml"),
    "packages:\n  pkg:\n    resolution: {repo: attacker/repo, type: git}\n",
  );
  await assert.rejects(
    validateCandidateFetchInputs(candidateDir),
    /non-registry dependency resolution/u,
  );
  await writeFile(
    path.join(candidateDir, "pnpm-lock.yaml"),
    'packages: {pkg: {"resolution": {tarball: "http://127.0.0.1:3000/pkg.tgz"}}}\n',
  );
  await assert.rejects(
    validateCandidateFetchInputs(candidateDir),
    /non-registry dependency resolution/u,
  );
  await writeFile(path.join(candidateDir, "pnpm-lock.yaml"), safePnpmLock);

  await writeFile(
    path.join(npmDir, "package-lock.json"),
    JSON.stringify({
      ...safeNpmLock,
      packages: {
        ...safeNpmLock.packages,
        "node_modules/pkg": {
          resolved: "http://127.0.0.1:3000/pkg.tgz",
          integrity: "sha512-AAAA",
        },
      },
    }),
  );
  await assert.rejects(
    validateCandidateFetchInputs(candidateDir),
    /package source is unsafe/u,
  );
});

test("recovery accepts only marked direct children of the release root", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bb-vps-releases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, "releases");
  const valid = path.join(releaseRoot, "abc123");
  await mkdir(valid, { recursive: true });
  await writeFile(
    path.join(valid, ".bb-vps-release.json"),
    JSON.stringify({ commit: "abc123", complete: true }),
  );

  await expectRelease(valid);
  await assert.rejects(
    validateOwnedVpsRelease(releaseRoot, root),
    /outside the owned release root/u,
  );

  const mismatched = path.join(releaseRoot, "def456");
  await mkdir(mismatched);
  await writeFile(
    path.join(mismatched, ".bb-vps-release.json"),
    JSON.stringify({ commit: "other", complete: true }),
  );
  await assert.rejects(
    validateOwnedVpsRelease(releaseRoot, mismatched),
    /marker does not match/u,
  );

  const linked = path.join(releaseRoot, "linked");
  await symlink(valid, linked);
  await assert.rejects(
    validateOwnedVpsRelease(releaseRoot, linked),
    /not an owned directory/u,
  );

  async function expectRelease(target) {
    assert.equal(await validateOwnedVpsRelease(releaseRoot, target), target);
  }
});

test("recovery removes only an operation-owned incomplete candidate", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bb-vps-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, "releases");
  const updatesDir = path.join(root, "updates");
  const operationId = "op-1";
  const commit = "a".repeat(40);
  const releaseDir = path.join(releaseRoot, commit);
  const ownerPath = path.join(updatesDir, `${operationId}.candidate`);
  await mkdir(releaseDir, { recursive: true });
  await mkdir(updatesDir, { recursive: true });
  await writeFile(path.join(releaseDir, "partial"), "incomplete");
  await writeFile(
    ownerPath,
    JSON.stringify({ operationId, commit, releaseDir }),
    { mode: 0o600 },
  );
  const removed = [];

  assert.equal(
    await recoverCandidateBuild(
      { releaseRoot, operationId, ownerPath },
      {
        async removeCandidate(target) {
          removed.push(target);
          await rm(target, { recursive: true, force: true });
        },
      },
    ),
    true,
  );
  assert.deepEqual(removed, [releaseDir]);
  await assert.rejects(lstat(releaseDir), { code: "ENOENT" });
  await assert.rejects(lstat(ownerPath), { code: "ENOENT" });
});

test("recovery preserves candidates when the ownership marker is forged", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bb-vps-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, "releases");
  const updatesDir = path.join(root, "updates");
  const commit = "a".repeat(40);
  const releaseDir = path.join(releaseRoot, commit);
  const ownerPath = path.join(updatesDir, "op-1.candidate");
  await mkdir(releaseDir, { recursive: true });
  await mkdir(updatesDir, { recursive: true });
  await writeFile(
    ownerPath,
    JSON.stringify({
      operationId: "other-operation",
      commit,
      releaseDir,
    }),
    { mode: 0o600 },
  );

  await assert.rejects(
    recoverCandidateBuild({ releaseRoot, operationId: "op-1", ownerPath }),
    /owner file is invalid/u,
  );
  assert.equal((await lstat(releaseDir)).isDirectory(), true);
});

function activationHarness({
  activity = {},
  activeWorkConfirmed,
  sealFailure,
  verifyFailure,
  rollbackFailure,
  releaseFailure,
  pluginFailure,
  transitionFailure,
} = {}) {
  const calls = [];
  let currentPhase = "draining";
  const admin = {
    async acquire() {
      calls.push("acquire");
      return {
        lease: { phase: "draining" },
        barrier: [{ hostId: "host-1", state: "quiesced", error: null }],
        activity: { activeByKind: activity },
        replayed: false,
      };
    },
    async seal() {
      calls.push("seal");
      if (sealFailure) throw sealFailure;
      currentPhase = "sealed";
      return { lease: { phase: currentPhase } };
    },
    async transition(input) {
      calls.push(`transition:${input.phase}`);
      if (transitionFailure === input.phase) {
        throw new Error(`${input.phase} unavailable`);
      }
      currentPhase = input.phase;
    },
    async status() {
      calls.push("status");
      return { lease: { phase: currentPhase } };
    },
    async release(input) {
      calls.push(`release:${input.resolution}`);
      if (releaseFailure) throw releaseFailure;
    },
  };
  return {
    calls,
    admin,
    runtime: {
      async confirmActiveWork(entries) {
        calls.push(
          `confirm:${entries.map(([kind, count]) => `${kind}=${count}`).join(",")}`,
        );
        return activeWorkConfirmed ?? false;
      },
      async switchCurrent(target) {
        calls.push(`switch:${target}`);
      },
      async restart() {
        calls.push("restart");
      },
      async waitForAdmin() {},
      async verify(identity) {
        calls.push(`verify:${identity}`);
        if (identity === "candidate" && verifyFailure) throw verifyFailure;
        if (identity === "previous" && rollbackFailure) throw rollbackFailure;
      },
      async installPlugins() {
        calls.push("plugins");
        if (pluginFailure) throw pluginFailure;
      },
    },
  };
}

const activation = {
  operationId: "op-1",
  ownerSecret: "secret",
  reason: "update",
  ttlMs: 60_000,
  candidateRelease: "candidate",
  previousRelease: "previous",
  allowActiveWork: false,
  plugins: true,
};

test("active work discovered after the barrier prevents sealing and restart", async () => {
  const harness = activationHarness({ activity: { "thread.start": 1 } });
  await assert.rejects(
    activateVpsRelease(activation, harness),
    (error) => error instanceof VpsUpdateError && error.exitCode === 5,
  );
  assert.deepEqual(harness.calls, ["acquire", "release:force-aborted"]);
});

test("the service cannot restart until the fail-closed seal succeeds", async () => {
  const harness = activationHarness({ sealFailure: new Error("seal failed") });
  await assert.rejects(
    activateVpsRelease(activation, harness),
    (error) => error instanceof VpsUpdateError && error.exitCode === 6,
  );
  assert.deepEqual(harness.calls, ["acquire", "seal"]);
});

test("break-glass active work requires exact operator confirmation", async () => {
  const refused = activationHarness({
    activity: { terminals: 2, threads: 1 },
  });
  await assert.rejects(
    activateVpsRelease({ ...activation, allowActiveWork: true }, refused),
    (error) => error instanceof VpsUpdateError && error.exitCode === 5,
  );
  assert.deepEqual(refused.calls, [
    "acquire",
    "confirm:terminals=2,threads=1",
    "release:force-aborted",
  ]);

  const accepted = activationHarness({
    activity: { terminals: 2, threads: 1 },
    activeWorkConfirmed: true,
  });
  await activateVpsRelease({ ...activation, allowActiveWork: true }, accepted);
  assert.ok(accepted.calls.includes("seal"));
  assert.ok(accepted.calls.includes("restart"));
});

test("candidate failure rolls back while maintenance remains sealed", async () => {
  const harness = activationHarness({
    verifyFailure: new Error("candidate dead"),
  });
  await assert.rejects(
    activateVpsRelease(activation, harness),
    (error) => error instanceof VpsUpdateError && error.exitCode === 7,
  );
  assert.deepEqual(harness.calls, [
    "acquire",
    "seal",
    "transition:activating",
    "switch:candidate",
    "restart",
    "transition:verifying",
    "verify:candidate",
    "switch:previous",
    "restart",
    "verify:previous",
    "transition:rolling-back",
    "release:rolled-back",
  ]);
});

test("waits for the restarted admin socket before entering verification", async () => {
  const harness = activationHarness();
  harness.runtime.waitForAdmin = async (identity) => {
    harness.calls.push(`wait-for-admin:${identity}`);
  };
  await activateVpsRelease(activation, harness);
  assert.deepEqual(harness.calls.slice(2, 8), [
    "transition:activating",
    "switch:candidate",
    "restart",
    "wait-for-admin:candidate",
    "transition:verifying",
    "verify:candidate",
  ]);
});

test("candidate admin failure cannot prevent restoring the previous release", async () => {
  const harness = activationHarness({ transitionFailure: "verifying" });
  await assert.rejects(
    activateVpsRelease(activation, harness),
    (error) => error instanceof VpsUpdateError && error.exitCode === 7,
  );
  assert.deepEqual(harness.calls.slice(6, 10), [
    "switch:previous",
    "restart",
    "verify:previous",
    "transition:rolling-back",
  ]);
});

test("plugin failure restores the previous release before reopening admission", async () => {
  const harness = activationHarness({
    pluginFailure: new Error("dir-skills failed"),
  });
  await assert.rejects(
    activateVpsRelease(activation, harness),
    (error) => error instanceof VpsUpdateError && error.exitCode === 7,
  );
  assert.deepEqual(harness.calls.slice(-6), [
    "plugins",
    "switch:previous",
    "restart",
    "verify:previous",
    "transition:rolling-back",
    "release:rolled-back",
  ]);
});

test("plugin source restoration failure retains sealed maintenance", async () => {
  const harness = activationHarness({
    pluginFailure: new VpsUpdateError(
      "plugin sources could not be restored",
      8,
    ),
  });
  await assert.rejects(
    activateVpsRelease(activation, harness),
    (error) => error instanceof VpsUpdateError && error.exitCode === 8,
  );
  assert.equal(
    harness.calls.filter((call) => call.startsWith("release:")).length,
    0,
  );
  assert.equal(harness.calls.at(-1), "transition:rollback-failed");
});

test("partial VPS plugin synchronization restores every previous source", () => {
  const sources = new Map([
    ["shared-runtime", "path:/old/shared-runtime"],
    ["dir-skills", "path:/old/dir-skills"],
  ]);
  const calls = [];
  const execute = (_cli, args) => {
    calls.push(args.join(" "));
    const [group, action] = args;
    assert.equal(group, "plugin");
    if (action === "source") {
      const source = sources.get(args[2]);
      return source === undefined
        ? { status: 1, stdout: "", stderr: "unknown plugin" }
        : {
            status: 0,
            stdout: JSON.stringify({ requested: source }),
            stderr: "",
          };
    }
    if (action === "remove") {
      sources.delete(args[2]);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (action === "install") {
      const source = args.at(-1);
      const id = source.endsWith("/shared-runtime")
        ? "shared-runtime"
        : "dir-skills";
      if (source === "path:/candidate/local/plugins/dir-skills") {
        throw new Error("candidate dir-skills failed");
      }
      sources.set(id, source);
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };

  assert.throws(
    () => syncVpsPlugins({ cli: "bb", candidateDir: "/candidate" }, execute),
    /candidate dir-skills failed/u,
  );
  assert.deepEqual(Object.fromEntries(sources), {
    "shared-runtime": "path:/old/shared-runtime",
    "dir-skills": "path:/old/dir-skills",
  });
  assert.ok(calls.includes("plugin install --yes path:/old/shared-runtime"));
  assert.ok(calls.includes("plugin install --yes path:/old/dir-skills"));
});

test("rollback failure retains fail-closed maintenance", async () => {
  const harness = activationHarness({
    verifyFailure: new Error("candidate dead"),
    rollbackFailure: new Error("previous dead"),
  });
  await assert.rejects(
    activateVpsRelease(activation, harness),
    (error) => error instanceof VpsUpdateError && error.exitCode === 8,
  );
  assert.equal(
    harness.calls.filter((call) => call.startsWith("release:")).length,
    0,
  );
  assert.equal(harness.calls.at(-1), "transition:rollback-failed");
});

test("release failure retains the healthy candidate without attempting rollback", async () => {
  const harness = activationHarness({
    releaseFailure: new Error("daemon unavailable"),
  });
  await assert.rejects(
    activateVpsRelease(activation, harness),
    (error) => error instanceof VpsUpdateError && error.exitCode === 9,
  );
  assert.deepEqual(harness.calls.slice(-3), [
    "verify:candidate",
    "plugins",
    "release:completed",
  ]);
  assert.equal(
    harness.calls.filter((call) => call === "switch:previous").length,
    0,
  );
});

test("recovery restores and resolves every durable post-seal phase", async () => {
  for (const phase of [
    "sealed",
    "activating",
    "verifying",
    "plugins",
    "rolling-back",
    "rollback-failed",
    "releasing",
    "plugin-failed",
  ]) {
    const calls = [];
    const admin = {
      async status() {
        calls.push("status");
        return { lease: { operationId: "op-1", phase } };
      },
      async transition(input) {
        calls.push(`transition:${input.expectedPhase}->${input.phase}`);
      },
      async release(input) {
        calls.push(`release:${input.resolution}`);
      },
    };
    await recoverVpsRelease(
      {
        operationId: "op-1",
        ownerSecret: "secret",
        record: { phase, previousRelease: "previous" },
      },
      {
        admin,
        runtime: {
          async restorePrevious(target) {
            calls.push(`restore:${target}`);
          },
        },
      },
    );
    assert.equal(calls[0], "restore:previous");
    assert.equal(calls.at(-1), "release:rolled-back");
    if (phase === "rolling-back" || phase === "releasing") {
      assert.equal(
        calls.some((call) => call.startsWith("transition:")),
        false,
      );
    } else {
      assert.ok(calls.includes(`transition:${phase}->rolling-back`));
    }
  }
});

test("legacy bootstrap recovery restores without using the admin protocol", async () => {
  const calls = [];
  await recoverVpsRelease(
    {
      operationId: "op-bootstrap",
      ownerSecret: null,
      record: { phase: "candidate-failed", previousRelease: "previous" },
    },
    {
      admin: new Proxy(
        {},
        {
          get() {
            throw new Error("legacy recovery must not use the admin protocol");
          },
        },
      ),
      runtime: {
        async restorePrevious(target) {
          calls.push(`restore:${target}`);
        },
      },
    },
  );
  assert.deepEqual(calls, ["restore:previous"]);
});

test("first bootstrap failure restores the inactive no-current state", async () => {
  const calls = [];
  await assert.rejects(
    activateBootstrapRelease(
      { candidateRelease: "candidate", previousRelease: "none" },
      {
        runtime: {
          async reportPhase(phase) {
            calls.push(`phase:${phase}`);
          },
          async switchCurrent(target) {
            calls.push(`switch:${target}`);
          },
          async start() {
            calls.push("start");
            throw new Error("start failed");
          },
          async verify() {
            calls.push("verify");
          },
          async restorePrevious(target) {
            calls.push(`restore:${target}`);
          },
          async restoreInactive() {
            calls.push("restore:inactive");
          },
          async reportFailure() {
            calls.push("phase:candidate-failed");
          },
        },
      },
    ),
    (error) => error instanceof VpsUpdateError && error.exitCode === 7,
  );
  assert.deepEqual(calls, [
    "phase:activating",
    "switch:candidate",
    "start",
    "restore:inactive",
    "phase:candidate-failed",
  ]);
});

test("bootstrap rollback failure remains recoverable and is recorded", async () => {
  const calls = [];
  await assert.rejects(
    activateBootstrapRelease(
      { candidateRelease: "candidate", previousRelease: "previous" },
      {
        runtime: {
          async reportPhase(phase) {
            calls.push(`phase:${phase}`);
          },
          async switchCurrent(target) {
            calls.push(`switch:${target}`);
          },
          async start() {
            calls.push("start");
          },
          async verify() {
            calls.push("verify");
            throw new Error("candidate failed");
          },
          async restorePrevious(target) {
            calls.push(`restore:${target}`);
            throw new Error("rollback failed");
          },
          async restoreInactive() {
            calls.push("restore:inactive");
          },
          async reportFailure(error) {
            calls.push(`phase:candidate-failed:${error.message}`);
          },
        },
      },
    ),
    (error) => error instanceof VpsUpdateError && error.exitCode === 8,
  );
  assert.deepEqual(calls, [
    "phase:activating",
    "switch:candidate",
    "start",
    "phase:verifying",
    "verify",
    "restore:previous",
    "phase:candidate-failed:rollback failed",
  ]);
});
